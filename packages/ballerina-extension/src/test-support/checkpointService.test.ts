/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Checkpoint } from "@wso2/ballerina-core/lib/state-machine-types";
import { Uri, window, workspace } from "./__mocks__/vscode";

jest.mock("../rpc-managers/visualizer/rpc-manager", () => ({
    VisualizerRpcManager: class {
        updateCurrentArtifactLocation() {}
    },
}));
jest.mock("../stateMachine", () => ({
    StateMachine: { context: () => ({}) },
    updateView: () => {},
}));
jest.mock("../rpc-managers/data-mapper/utils", () => ({
    refreshDataMapper: () => Promise.resolve(),
}));
jest.mock("../RPCLayer", () => ({
    notifyCurrentWebview: () => {},
    suppressWebviewNotifications: () => () => {},
}));

import * as restoreApplier from "../views/ai-panel/checkpoint/restoreApplier";
import { CheckpointConfig, DEFAULT_CHECKPOINT_CONFIG } from "../views/ai-panel/checkpoint/checkpointConfig";
import { CheckpointService, getCheckpointService } from "../views/ai-panel/checkpoint/checkpointService";
import { VscodeCheckpointNotifier } from "../views/ai-panel/checkpoint/checkpointNotifier";
import { FsBlobStore } from "../views/ai-panel/checkpoint/blobStore";
import { InlineSnapshotBackend } from "../views/ai-panel/checkpoint/backends/inlineSnapshotBackend";
import { ContentStoreBackend } from "../views/ai-panel/checkpoint/backends/contentStoreBackend";
import type { CheckpointNotifier } from "../views/ai-panel/checkpoint/types";

type Kind = "inline" | "content-store";

const ORIGINAL_BAL = "// before the generation\n";
const ORIGINAL_CONFIG = 'greeting = "before the generation"\n';

interface FakeDocument {
    uri: { fsPath: string; scheme: string; toString(): string };
    isDirty: boolean;
    text: string;
    save(): Promise<boolean>;
    getText(): string;
}

function recordingNotifier() {
    const calls: { method: keyof CheckpointNotifier; args: unknown[] }[] = [];
    const notifier: CheckpointNotifier = {
        tooLarge: (...args) => { calls.push({ method: "tooLarge", args }); },
        largeFilesSkipped: (...args) => { calls.push({ method: "largeFilesSkipped", args }); },
        unknownFormat: (...args) => { calls.push({ method: "unknownFormat", args }); },
        contentUnavailable: (...args) => { calls.push({ method: "contentUnavailable", args }); },
    };
    return { notifier, calls, methods: () => calls.map(c => c.method) };
}

describe("CheckpointService", () => {
    let root: string;
    let storeDir: string;
    let store: FsBlobStore;
    let inline: InlineSnapshotBackend;
    let contentStore: ContentStoreBackend;
    let config: CheckpointConfig;
    let notify: ReturnType<typeof recordingNotifier>;
    let warnings: string[];
    let errors: string[];
    let modalPrompts: string[];
    let documents: FakeDocument[];

    const at = (name: string) => path.join(root, name);
    const service = (defaultKind: Kind = "content-store") => new CheckpointService({
        backends: [inline, contentStore],
        defaultKind,
        config: () => config,
        notify: notify.notifier,
    });
    const openEditor = (name: string, text: string, isDirty: boolean) => {
        const uri = Uri.file(at(name));
        const doc: FakeDocument = {
            uri,
            isDirty,
            text,
            save: () => Promise.resolve(true),
            getText: () => doc.text,
        };
        documents.push(doc);
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-service-"));
        storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-service-objects-"));
        store = new FsBlobStore(storeDir);
        inline = new InlineSnapshotBackend();
        contentStore = new ContentStoreBackend(store);
        config = { ...DEFAULT_CHECKPOINT_CONFIG };
        notify = recordingNotifier();
        warnings = [];
        errors = [];
        modalPrompts = [];
        documents = [];

        fs.writeFileSync(at("main.bal"), ORIGINAL_BAL);
        fs.writeFileSync(at("Config.toml"), ORIGINAL_CONFIG);

        workspace.workspaceFolders = [{ uri: Uri.file(root) }];
        workspace.findFiles = () => Promise.resolve(fs.readdirSync(root).map(name => Uri.file(at(name))));
        workspace.textDocuments = documents as never;
        // A small editor: edits land in open documents, and saveAll writes the dirty ones to disk.
        workspace.applyEdit = (edit: unknown) => {
            for (const entry of (edit as { entries: { op: string; uri: { fsPath: string }; content?: string }[] }).entries) {
                const doc = documents.find(d => d.uri.fsPath === entry.uri.fsPath);
                if (entry.op === "replace") {
                    if (doc) {
                        doc.text = entry.content ?? "";
                        doc.isDirty = true;
                    } else {
                        fs.writeFileSync(entry.uri.fsPath, entry.content ?? "");
                    }
                }
            }
            return Promise.resolve(true);
        };
        workspace.saveAll = () => {
            for (const doc of documents.filter(d => d.isDirty)) {
                fs.writeFileSync(doc.uri.fsPath, doc.text);
                doc.isDirty = false;
            }
            return Promise.resolve(true);
        };
        window.showWarningMessage = ((message: string, ...rest: unknown[]) => {
            const isModal = typeof rest[0] === "object" && rest[0] !== null;
            (isModal ? modalPrompts : warnings).push(message);
            return Promise.resolve(isModal ? (rest[1] as string) : undefined);
        }) as never;
        window.showErrorMessage = ((message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        }) as never;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    describe("capture", () => {
        it("stores new checkpoints in the content store, stamped as schema 2", async () => {
            const cp = await service().capture("msg-1");

            expect(cp?.storage?.kind).toBe("content-store");
            expect(cp?.workspaceSnapshot).toBeUndefined();
            expect(cp?.schemaVersion).toBe(2);
            expect(cp?.fileList.sort()).toEqual(["Config.toml", "main.bal"]);
        });

        it("defaults the per-workspace service to the content store and reuses it", () => {
            const projectRoot = path.join(os.tmpdir(), "checkpoint-service-default");

            expect(getCheckpointService(projectRoot).defaultKind).toBe("content-store");
            expect(getCheckpointService(projectRoot)).toBe(getCheckpointService(projectRoot));
        });

        it("returns null and says so when the new content is over the limit", async () => {
            config.maxSnapshotSize = 8;

            await expect(service().capture("msg-1")).resolves.toBeNull();

            expect(notify.methods()).toEqual(["tooLarge"]);
        });

        it("names the large files it left out, once per session", async () => {
            fs.writeFileSync(at("dataset.csv"), "x".repeat(64));
            config.maxFileSize = 48;
            const infos: string[] = [];
            window.showInformationMessage = ((message: string) => {
                infos.push(message);
                return Promise.resolve(undefined);
            }) as never;
            const notifier = new VscodeCheckpointNotifier(() => config);
            const svc = new CheckpointService({
                backends: [inline, contentStore], defaultKind: "content-store", config: () => config, notify: notifier,
            });

            expect(await svc.capture("msg-1")).not.toBeNull();
            expect(await svc.capture("msg-2")).not.toBeNull();

            expect(infos).toEqual([
                "Some large files are not included in Copilot checkpoints, so a revert will not change them: dataset.csv.",
            ]);
        });
    });

    describe("restore", () => {
        it("routes a migrated v1 checkpoint to the inline backend", async () => {
            fs.writeFileSync(at("main.bal"), "// the generation's edit\n");
            const inlineResolve = jest.spyOn(inline, "resolve");
            const storeResolve = jest.spyOn(contentStore, "resolve");
            const cp: Checkpoint = {
                id: "cp-1", messageId: "msg-1", timestamp: 0, schemaVersion: 2, snapshotSize: 0,
                fileList: ["main.bal", "Config.toml"],
                storage: { kind: "inline" },
                workspaceSnapshot: { "main.bal": ORIGINAL_BAL, "Config.toml": ORIGINAL_CONFIG },
                workspaceRoot: root,
            };

            await expect(service().restore(cp, { skipArtifactWait: true })).resolves.toBe(true);

            expect(inlineResolve).toHaveBeenCalled();
            expect(storeResolve).not.toHaveBeenCalled();
            expect(fs.readFileSync(at("main.bal"), "utf8")).toBe(ORIGINAL_BAL);
        });

        it.each<[string, Partial<Checkpoint>]>([
            ["a newer schema", { schemaVersion: 3, storage: { kind: "inline" }, workspaceSnapshot: {} }],
            ["an unknown storage kind", { storage: { kind: "journal" } as never }],
            ["an inline checkpoint without a snapshot object", { storage: { kind: "inline" }, workspaceSnapshot: "x" as never }],
            ["a storage-less checkpoint with a string snapshot", { workspaceSnapshot: "abc" as never }],
            ["a storage-less checkpoint without a snapshot", {}],
            ["a content-store checkpoint without a files object", { storage: { kind: "content-store", files: null } as never }],
        ])("refuses %s before touching anything", async (_name, shape) => {
            fs.writeFileSync(at("added-by-hand.csv"), "id\n");
            const write = jest.spyOn(restoreApplier, "writeRestorePlan");
            const apply = jest.spyOn(restoreApplier, "applyRestorePlan");
            const cp: Checkpoint = {
                id: "cp-1", messageId: "msg-1", timestamp: 0, snapshotSize: 0, fileList: ["main.bal"],
                workspaceRoot: root, ...shape,
            };

            await expect(service().restore(cp)).resolves.toBe(false);

            expect(notify.methods()).toEqual(["unknownFormat"]);
            expect(write).not.toHaveBeenCalled();
            expect(apply).not.toHaveBeenCalled();
            expect(modalPrompts).toEqual([]);
            expect(fs.existsSync(at("added-by-hand.csv"))).toBe(true);
        });

        it("changes nothing and asks nothing when a stored blob is missing", async () => {
            const svc = service();
            const cp = (await svc.capture("msg-1"))!;
            fs.writeFileSync(at("main.bal"), "// the generation's edit\n");
            fs.writeFileSync(at("added-by-the-generation.bal"), "// new\n");
            fs.rmSync(storeDir, { recursive: true, force: true });
            const write = jest.spyOn(restoreApplier, "writeRestorePlan");

            await expect(svc.restore(cp, { skipArtifactWait: true })).resolves.toBe(false);

            expect(notify.methods()).toEqual(["contentUnavailable"]);
            expect(write).not.toHaveBeenCalled();
            expect(modalPrompts).toEqual([]);
            expect(fs.readFileSync(at("main.bal"), "utf8")).toBe("// the generation's edit\n");
            expect(fs.existsSync(at("added-by-the-generation.bal"))).toBe(true);
        });

        it("refuses a checkpoint captured against a different workspace root, as before", async () => {
            const cp = (await service().capture("msg-1"))!;
            cp.workspaceRoot = path.join(path.dirname(root), "some-other-workspace");
            fs.writeFileSync(at("main.bal"), "// the generation's edit\n");

            await expect(service().restore(cp, { skipArtifactWait: true })).resolves.toBe(false);

            expect(errors).toEqual([
                `Cannot restore checkpoint: This checkpoint was taken in a different workspace (${cp.workspaceRoot}), so it cannot be restored here.`,
            ]);
            expect(fs.readFileSync(at("main.bal"), "utf8")).toBe("// the generation's edit\n");
        });

        describe.each<Kind>(["inline", "content-store"])("with a dirty editor over an unchanged file (%s)", (kind) => {
            it.each(["main.bal", "Config.toml"])("leaves %s with the checkpoint content", async (name) => {
                const svc = service(kind);
                const cp = (await svc.capture("msg-1"))!;
                const original = fs.readFileSync(at(name), "utf8");
                openEditor(name, "half-typed edit the user has not saved\n", true);

                await expect(svc.restore(cp, { skipArtifactWait: true })).resolves.toBe(true);

                expect(fs.readFileSync(at(name), "utf8")).toBe(original);
            });
        });

        it("leaves a large file that changed since capture alone, and names it", async () => {
            fs.writeFileSync(at("dataset.csv"), "x".repeat(64));
            config.maxFileSize = 48;
            const svc = service();
            const cp = (await svc.capture("msg-1"))!;
            fs.writeFileSync(at("dataset.csv"), "y".repeat(80));

            await expect(svc.restore(cp, { skipArtifactWait: true })).resolves.toBe(true);

            expect(fs.readFileSync(at("dataset.csv"), "utf8")).toBe("y".repeat(80));
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("dataset.csv");
            expect(modalPrompts).toEqual([]);
        });

        it("does not mention a large file that is unchanged since capture", async () => {
            fs.writeFileSync(at("dataset.csv"), "x".repeat(64));
            config.maxFileSize = 48;
            const svc = service();
            const cp = (await svc.capture("msg-1"))!;
            fs.writeFileSync(at("main.bal"), "// the generation's edit\n");

            await expect(svc.restore(cp, { skipArtifactWait: true })).resolves.toBe(true);

            expect(warnings).toEqual([]);
            expect(fs.readFileSync(at("main.bal"), "utf8")).toBe(ORIGINAL_BAL);
        });
    });

    describe("readers and garbage collection", () => {
        it("reads originals with '/'-separated keys", async () => {
            fs.mkdirSync(at("modules"));
            fs.writeFileSync(at(path.join("modules", "util.bal")), "// util\n");
            workspace.findFiles = () => Promise.resolve([
                Uri.file(at("main.bal")), Uri.file(at(path.join("modules", "util.bal"))),
            ]);
            const svc = service();
            const cp = (await svc.capture("msg-1"))!;

            const originals = await svc.readOriginals(cp, [path.join("modules", "util.bal"), "added.bal"]);

            const util = originals.get("modules/util.bal");
            expect(util?.state === "content" && util.bytes.toString("utf8")).toBe("// util\n");
            expect(originals.get("added.bal")).toEqual({ state: "absent" });
        });

        it("sweeps only blobs no live checkpoint references", async () => {
            const svc = service();
            const live = (await svc.capture("msg-1"))!;
            const { id: orphan } = await store.put(Buffer.from("no longer referenced"));
            const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
            for (const shard of fs.readdirSync(storeDir)) {
                for (const name of fs.readdirSync(path.join(storeDir, shard))) {
                    fs.utimesSync(path.join(storeDir, shard, name), past, past);
                }
            }

            await svc.collectGarbage([live]);

            expect(await store.get(orphan)).toBeUndefined();
            const files = live.storage?.kind === "content-store" ? live.storage.files : {};
            for (const entry of Object.values(files)) {
                expect("hash" in entry && await store.get(entry.hash)).toBeTruthy();
            }
        });

        it("sweeps nothing while a live checkpoint has a format it does not know", async () => {
            const svc = service();
            const { id: orphan } = await store.put(Buffer.from("maybe referenced"));
            const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
            fs.utimesSync(path.join(storeDir, orphan.slice(0, 2), orphan), past, past);

            await svc.collectGarbage([{ id: "cp-9", messageId: "m", timestamp: 0, snapshotSize: 0, fileList: [], schemaVersion: 3 }]);

            expect(await store.get(orphan)).toBeDefined();
        });
    });

    it("refuses to start against a checkpoint schema older than 2", () => {
        jest.isolateModules(() => {
            jest.doMock("@wso2/copilot-utilities/chat-persistence", () => ({
                ...jest.requireActual("@wso2/copilot-utilities/chat-persistence"),
                CURRENT_CHECKPOINT_SCHEMA_VERSION: 1,
            }));
            const isolated = require("../views/ai-panel/checkpoint/checkpointService");
            expect(() => new isolated.CheckpointService({
                backends: [inline], defaultKind: "inline", config: () => config, notify: notify.notifier,
            })).toThrow(/version 2/);
        });
    });
});

describe("VscodeCheckpointNotifier", () => {
    const shown: string[] = [];
    const record = (message: string) => {
        shown.push(message);
        return Promise.resolve(undefined);
    };

    beforeEach(() => {
        shown.length = 0;
        window.showWarningMessage = record as never;
        window.showErrorMessage = record as never;
        window.showInformationMessage = record as never;
    });

    it("words each notice as agreed", () => {
        const notifier = new VscodeCheckpointNotifier(() => ({ ...DEFAULT_CHECKPOINT_CONFIG }));

        notifier.tooLarge();
        notifier.largeFilesSkipped(["a.csv", "b.csv", "c.csv", "d.csv", "e.csv"]);
        notifier.largeFilesSkipped(["f.csv"]);
        notifier.unknownFormat();
        notifier.contentUnavailable("blob abc is missing");

        expect(shown).toEqual([
            "Too much new content to checkpoint this turn (over 50MB). This generation will not be revertible.",
            "Some large files are not included in Copilot checkpoints, so a revert will not change them: a.csv, b.csv, c.csv and 2 more.",
            "This checkpoint was made by a newer version and cannot be restored here.",
            "Cannot restore checkpoint: some of its saved content is missing. Nothing was changed.",
        ]);
    });
});
