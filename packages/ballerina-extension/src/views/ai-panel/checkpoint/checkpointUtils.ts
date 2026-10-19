/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
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

import * as vscode from 'vscode';
import { Checkpoint } from '@wso2/ballerina-core/lib/state-machine-types';
import { isSamePath } from '@wso2/ballerina-core/lib/utils/path-utils';
import { getCheckpointConfig } from './checkpointConfig';
import { scanWorkspace } from './workspaceScanner';
import { applyRestorePlan, isLosslessUtf8, realPathOfNearestAncestor, reportRestoreFailure } from './restoreApplier';
import { RestorePlan } from './types';

export { renderDatamapper } from './restoreApplier';

const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export async function captureWorkspaceSnapshot(messageId: string): Promise<Checkpoint | null> {
    const config = getCheckpointConfig();

    if (!config.enabled) {
        return null;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.warn('[Checkpoint] No workspace folder found');
        return null;
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const workspaceSnapshot: { [filePath: string]: string } = {};
    const fileList: string[] = [];
    let totalSize = 0;

    try {
        const allFiles = await scanWorkspace(workspaceRoot, config.ignorePatterns);

        // Read in bounded-concurrency chunks: one-at-a-time reads dominate run-start
        // latency on large workspaces, while unbounded Promise.all can exhaust file
        // handles. Hand-rolled rather than mapWithConcurrency because the size cap must
        // be able to abort between batches, which that helper cannot express; chunks
        // also keep fileList in findFiles order.
        const READ_CONCURRENCY = 32;
        for (let i = 0; i < allFiles.length; i += READ_CONCURRENCY) {
            const chunk = allFiles.slice(i, i + READ_CONCURRENCY);
            const chunkContents = await Promise.all(chunk.map(async file => {
                try {
                    const fileContent = await vscode.workspace.fs.readFile(file.uri);
                    return { file, bytes: Buffer.from(fileContent) };
                } catch (error) {
                    console.error(`[Checkpoint] Failed to read file ${file.uri.fsPath}:`, error);
                    return { file, bytes: null };
                }
            }));

            for (const entry of chunkContents) {
                if (!entry) { continue; }
                const relativePath = entry.file.path;
                fileList.push(relativePath);

                // Unreadable at capture — locked by another process, or permission denied. Listing it
                // without snapshotting it is what stops the restore deleting a file it never held.
                if (!entry.bytes) {
                    continue;
                }

                // Listed but not snapshotted: a snapshot holds strings, so bytes that do not survive
                // a UTF-8 round trip cannot be reproduced. Being in fileList keeps a restore from
                // deleting it; being out of the snapshot keeps a restore from writing a lossy decode
                // over it. Its size is not counted either — nothing is stored for it.
                if (!isLosslessUtf8(entry.bytes)) {
                    continue;
                }

                const content = entry.bytes.toString('utf8');
                workspaceSnapshot[relativePath] = content;
                totalSize += content.length;
            }

            if (totalSize > config.maxSnapshotSize) {
                // Fail closed rather than save a partial checkpoint that silently leaves
                // later-scanned files unrevertible on restore.
                console.warn(`[Checkpoint] Snapshot size exceeded max limit (${totalSize} bytes) — aborting capture, no partial checkpoint will be saved`);
                vscode.window.showWarningMessage(
                    `Workspace is too large to checkpoint (exceeds ${Math.round(config.maxSnapshotSize / 1024 / 1024)}MB). This generation will not be revertible.`
                );
                return null;
            }
        }

        const checkpoint: Checkpoint = {
            id: generateId(),
            messageId,
            timestamp: Date.now(),
            workspaceSnapshot,
            fileList,
            snapshotSize: totalSize,
            workspaceRoot: workspaceRoot.fsPath,
            ignorePatterns: config.ignorePatterns
        };

        return checkpoint;
    } catch (error) {
        console.error('[Checkpoint] Failed to capture workspace snapshot:', error);
        vscode.window.showErrorMessage('Failed to create checkpoint: ' + (error as Error).message);
        return null;
    }
}

/**
 * Restores the workspace to a checkpoint snapshot. Returns {@code true} only when the restore
 * actually applied; callers that mark a generation reverted (and tell the model its changes were
 * undone) must gate that on the return value, since a failed {@code applyEdit} is reported to the
 * user here but not thrown.
 */
export async function restoreWorkspaceSnapshot(checkpoint: Checkpoint, skipArtifactWait = false): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder found');
    }

    const workspaceRoot = workspaceFolders[0].uri;

    // Paths in a snapshot mean nothing without the root they were taken against: re-rooting one
    // into a different workspace rewrites files that never belonged to it and deletes everything
    // the snapshot does not list. Checkpoints captured before the root was recorded carry none,
    // and are let through rather than making every existing one unrevertible.
    const capturedRoot = checkpoint.workspaceRoot && realPathOfNearestAncestor(checkpoint.workspaceRoot);
    const currentRoot = realPathOfNearestAncestor(workspaceRoot.fsPath);
    if (checkpoint.workspaceRoot && (!capturedRoot || !currentRoot || !isSamePath(capturedRoot, currentRoot))) {
        const reason = `This checkpoint was taken in a different workspace (${checkpoint.workspaceRoot}), so it cannot be restored here.`;
        console.error(`[Checkpoint] Refusing a cross-root restore: ${reason}`);
        vscode.window.showErrorMessage(`Cannot restore checkpoint: ${reason}`);
        return false;
    }

    let plan: RestorePlan;
    try {
        // The patterns the snapshot was taken under, not today's: a pattern removed since would
        // turn everything it used to hide into "not in the snapshot", and delete it.
        const ignorePatterns = checkpoint.ignorePatterns ?? getCheckpointConfig().ignorePatterns;
        const currentFiles = await scanWorkspace(workspaceRoot, ignorePatterns);
        const snapshotFilePaths = new Set(checkpoint.fileList);
        plan = {
            root: workspaceRoot,
            writes: new Map(Object.entries(checkpoint.workspaceSnapshot ?? {})),
            deletes: currentFiles.map(file => file.path).filter(filePath => !snapshotFilePaths.has(filePath)),
            notRestored: []
        };
    } catch (error) {
        reportRestoreFailure(error);
        return false;
    }

    return applyRestorePlan(plan, { skipArtifactWait });
}
