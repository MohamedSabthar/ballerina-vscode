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
import { applyRestorePlan, realPathOfNearestAncestor, reportRestoreFailure } from './restoreApplier';
import { CheckpointTooLargeError, RestorePlan } from './types';
import { InlineSnapshotBackend } from './backends/inlineSnapshotBackend';
import { resolveCaptureLimits } from './backends/captureSupport';

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
    const limits = resolveCaptureLimits({ maxFileSize: config.maxFileSize, maxNewBytes: config.maxSnapshotSize });

    try {
        const allFiles = await scanWorkspace(workspaceRoot, config.ignorePatterns);
        const result = await new InlineSnapshotBackend().capture({
            workspaceRoot: workspaceRoot.fsPath,
            files: allFiles,
            limits
        });

        const checkpoint: Checkpoint = {
            id: generateId(),
            messageId,
            timestamp: Date.now(),
            ...result.fields,
            fileList: allFiles.map(file => file.path),
            snapshotSize: result.newBytes,
            workspaceRoot: workspaceRoot.fsPath,
            ignorePatterns: config.ignorePatterns
        };

        return checkpoint;
    } catch (error) {
        if (error instanceof CheckpointTooLargeError) {
            // Fail closed rather than save a partial checkpoint that silently leaves
            // later-scanned files unrevertible on restore.
            console.warn(`[Checkpoint] ${error.message} — aborting capture, no partial checkpoint will be saved`);
            vscode.window.showWarningMessage(
                `Workspace is too large to checkpoint (exceeds ${Math.round(limits.maxNewBytes / 1024 / 1024)}MB). This generation will not be revertible.`
            );
            return null;
        }
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
