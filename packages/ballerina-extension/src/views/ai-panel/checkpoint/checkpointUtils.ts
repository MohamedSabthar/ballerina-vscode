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
import { CheckpointService, getCheckpointService } from './checkpointService';

export { renderDatamapper } from './restoreApplier';

// Inline, so the commands built on these keep producing the checkpoints they always did.
function legacyService(): CheckpointService {
    return getCheckpointService(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', 'inline');
}

export async function captureWorkspaceSnapshot(messageId: string): Promise<Checkpoint | null> {
    return legacyService().capture(messageId);
}

/**
 * Restores the workspace to a checkpoint snapshot. Returns {@code true} only when the restore
 * actually applied; callers that mark a generation reverted (and tell the model its changes were
 * undone) must gate that on the return value, since a failed {@code applyEdit} is reported to the
 * user here but not thrown.
 */
export async function restoreWorkspaceSnapshot(checkpoint: Checkpoint, skipArtifactWait = false): Promise<boolean> {
    return legacyService().restore(checkpoint, { skipArtifactWait });
}
