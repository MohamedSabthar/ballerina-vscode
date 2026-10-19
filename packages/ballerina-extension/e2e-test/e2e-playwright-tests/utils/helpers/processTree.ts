/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
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
import { execFileSync } from 'child_process';

// The processes under a pid, parents first: the extension host under Electron, the language server
// and any `bal run` under the extension host. Read before the root is killed, since killing it
// reparents them to init and the tree is gone. Empty on Windows, where taskkill takes the tree itself.
export function descendantPids(root: number): number[] {
    return descendants(root).map((entry) => entry.pid);
}

export interface ProcessEntry {
    pid: number;
    command: string;
}

export function descendants(root: number): ProcessEntry[] {
    if (process.platform === 'win32') {
        return [];
    }
    const childrenOf = new Map<number, ProcessEntry[]>();
    let table: string;
    try {
        table = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 10000 });
    } catch {
        return [];
    }
    for (const line of table.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) {
            continue;
        }
        const entry = { pid: Number(match[1]), command: match[3] };
        const ppid = Number(match[2]);
        (childrenOf.get(ppid) ?? childrenOf.set(ppid, []).get(ppid)!).push(entry);
    }
    const found: ProcessEntry[] = [];
    const queue = [root];
    while (queue.length > 0) {
        for (const child of childrenOf.get(queue.shift()!) ?? []) {
            found.push(child);
            queue.push(child.pid);
        }
    }
    return found;
}

// The command names of live processes, for the log line that says what a reap killed.
export function commandsOf(pids: number[]): string[] {
    if (process.platform === 'win32' || pids.length === 0) {
        return [];
    }
    try {
        return execFileSync('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10000 })
            .split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

// Kills a process tree. On Windows taskkill /T takes the root and everything under it; elsewhere the
// root is the caller's to kill and the descendants collected earlier are killed here, parents first.
export function killProcessTree(root: number, descendants: number[]): number {
    if (process.platform === 'win32') {
        try {
            execFileSync('taskkill', ['/PID', String(root), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
        } catch {
            // already gone
        }
        return 0;
    }
    let killed = 0;
    for (const pid of descendants) {
        try {
            process.kill(pid, 'SIGKILL');
            killed++;
        } catch {
            // already gone
        }
    }
    return killed;
}
