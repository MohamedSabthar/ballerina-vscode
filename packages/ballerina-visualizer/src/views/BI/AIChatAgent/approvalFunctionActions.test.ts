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

// FlowDiagram/utils pulls in the ballerina-core barrel (ESM-only deps jest can't load); the lookup
// these actions rely on is a plain name match over project components, stubbed here.
jest.mock("../FlowDiagram/utils", () => ({
    findFunctionByName: (components: { functions: any[] }, name: string) =>
        components.functions.find((fn) => fn.name === name) ?? null,
}));

jest.mock("@wso2/ballerina-core", () => ({
    EVENT_TYPE: { OPEN_VIEW: "OPEN_VIEW" },
    MACHINE_VIEW: { BIDiagram: "BI Diagram" },
}));

import { createApprovalFunctionActions, readFunctionNodeParameters } from "./approvalFunctionActions";

function fakeRpcClient(functionNames: () => string[]) {
    const showErrorMessage = jest.fn();
    const openView = jest.fn();
    const rpcClient: any = {
        getBIDiagramRpcClient: () => ({
            getFunctionNode: async ({ functionName }: { functionName: string }) => ({
                functionDefinition: {
                    codedata: { data: { approvalFunctionFor: ["addToCart"] } },
                    properties: {
                        parameters: {
                            value: {
                                ids: { value: { type: { value: "string[]" }, variable: { value: "ids" } } },
                                id: { value: { type: { value: "string" }, variable: { value: functionName } } },
                            },
                        },
                    },
                },
            }),
            getProjectComponents: async () => ({
                components: {
                    functions: functionNames().map((name) => ({
                        name, filePath: "/p/agents.bal", startLine: 3, startColumn: 0, endLine: 5, endColumn: 1,
                    })),
                },
            }),
        }),
        getCommonRpcClient: () => ({ showErrorMessage }),
        getVisualizerRpcClient: () => ({ openView }),
        getVisualizerLocation: async () => ({ projectPath: "/p" }),
    };
    return { rpcClient, showErrorMessage, openView };
}

describe("approvalFunctionActions.verifyGenerated", () => {
    it("does nothing when no function was added", async () => {
        const { rpcClient, showErrorMessage } = fakeRpcClient(() => []);
        const actions = createApprovalFunctionActions(rpcClient);
        expect(await actions.verifyGenerated({ requiresApproval: "true" }, 0)).toBe(true);
        expect(await actions.verifyGenerated({ requiresApproval: "isHighValue" }, 0)).toBe(true);
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("passes once the added function exists", async () => {
        const { rpcClient, showErrorMessage } = fakeRpcClient(() => ["addToCartApproval"]);
        const actions = createApprovalFunctionActions(rpcClient);
        const ok = await actions.verifyGenerated(
            { requiresApproval: "addToCartApproval", generateApprovalFunction: "true" }, 0
        );
        expect(ok).toBe(true);
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("waits for the language server to catch up before giving up", async () => {
        let calls = 0;
        const { rpcClient, showErrorMessage } = fakeRpcClient(() => (++calls >= 2 ? ["addToCartApproval"] : []));
        const actions = createApprovalFunctionActions(rpcClient);
        const ok = await actions.verifyGenerated(
            { requiresApproval: "addToCartApproval", generateApprovalFunction: "true" }, 0
        );
        expect(ok).toBe(true);
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("warns when the language server didn't create the added function", async () => {
        const { rpcClient, showErrorMessage } = fakeRpcClient(() => []);
        const actions = createApprovalFunctionActions(rpcClient);
        const ok = await actions.verifyGenerated(
            { requiresApproval: "addToCartApproval", generateApprovalFunction: "true" }, 0
        );
        expect(ok).toBe(false);
        expect(showErrorMessage).toHaveBeenCalledTimes(1);
        expect(showErrorMessage.mock.calls[0][0].message).toContain("'addToCartApproval'");
        expect(showErrorMessage.mock.calls[0][0].message).toContain("language server may be out of date");
    });
});

describe("approvalFunctionActions.onOpenFunction", () => {
    it("opens the function's flow diagram", async () => {
        const { rpcClient, openView } = fakeRpcClient(() => ["addToCartApproval"]);
        await createApprovalFunctionActions(rpcClient).onOpenFunction("addToCartApproval");
        expect(openView).toHaveBeenCalledWith({
            type: "OPEN_VIEW",
            location: {
                documentUri: "/p/agents.bal",
                identifier: "addToCartApproval",
                position: { startLine: 3, startColumn: 0, endLine: 5, endColumn: 1 },
                view: "BI Diagram",
            },
        });
    });

    it("explains when the function can't be found", async () => {
        const { rpcClient, openView, showErrorMessage } = fakeRpcClient(() => []);
        await createApprovalFunctionActions(rpcClient).onOpenFunction("custApproval");
        expect(openView).not.toHaveBeenCalled();
        expect(showErrorMessage.mock.calls[0][0].message).toContain("'custApproval'");
    });
});

describe("approvalFunctionActions.getFunctionInfo", () => {
    it("reads the function's parameters and the tools that use it", async () => {
        const { rpcClient } = fakeRpcClient(() => ["addToCartApproval"]);
        expect(await createApprovalFunctionActions(rpcClient).getFunctionInfo("addToCartApproval")).toEqual({
            params: [{ type: "string[]", name: "ids" }, { type: "string", name: "addToCartApproval" }],
            usedBy: ["addToCart"],
        });
    });

    it("returns null when the function doesn't exist", async () => {
        const { rpcClient } = fakeRpcClient(() => []);
        expect(await createApprovalFunctionActions(rpcClient).getFunctionInfo("missing")).toBeNull();
    });
});

describe("readFunctionNodeParameters", () => {
    it("skips incomplete entries and tolerates missing values", () => {
        expect(readFunctionNodeParameters({ a: { value: { type: { value: "int" } } } })).toEqual([]);
        expect(readFunctionNodeParameters(undefined)).toEqual([]);
    });
});
