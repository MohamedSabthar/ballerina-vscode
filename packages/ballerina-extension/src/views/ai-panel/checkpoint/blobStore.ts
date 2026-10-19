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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { BlobStore, CheckpointBlobCorruptError } from './types';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const TEMP_SUFFIX = '.tmp';

export interface FsBlobStoreHooks {
    beforeUnlink?: (id: string) => Promise<void>;
}

export function blobStoreDir(workspaceDir: string): string {
    return path.join(workspaceDir, 'objects');
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class FsBlobStore implements BlobStore {
    constructor(private readonly dir: string, private readonly hooks?: FsBlobStoreHooks) {}

    exists(): boolean {
        return fs.existsSync(this.dir);
    }

    async put(bytes: Buffer): Promise<{ id: string; created: boolean }> {
        const id = crypto.createHash('sha256').update(bytes).digest('hex');
        if (await this.touch(id)) {
            return { id, created: false };
        }
        const target = this.blobPath(id);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${crypto.randomBytes(6).toString('hex')}${TEMP_SUFFIX}`;
        await fs.promises.writeFile(temp, await gzip(bytes, { level: 1 }));
        try {
            await fs.promises.rename(temp, target);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if ((code === 'EEXIST' || code === 'EPERM') && fs.existsSync(target)) {
                await fs.promises.rm(temp, { force: true });
                return { id, created: false };
            }
            await fs.promises.rm(temp, { force: true });
            throw error;
        }
        return { id, created: true };
    }

    async get(id: string): Promise<Buffer | undefined> {
        let stored: Buffer;
        try {
            stored = await fs.promises.readFile(this.blobPath(id));
        } catch (error) {
            if (isMissing(error)) {
                return undefined;
            }
            throw error;
        }
        let bytes: Buffer;
        try {
            bytes = await gunzip(stored);
        } catch {
            throw new CheckpointBlobCorruptError(`Checkpoint blob ${id} is not valid gzip`);
        }
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== id) {
            throw new CheckpointBlobCorruptError(`Checkpoint blob ${id} failed its checksum`);
        }
        return bytes;
    }

    async touch(id: string): Promise<boolean> {
        const now = new Date();
        try {
            await fs.promises.utimes(this.blobPath(id), now, now);
            return true;
        } catch (error) {
            if (isMissing(error)) {
                return false;
            }
            throw error;
        }
    }

    async sweep(live: ReadonlySet<string>, minAgeMs: number): Promise<number> {
        let shards: string[];
        try {
            shards = await fs.promises.readdir(this.dir);
        } catch (error) {
            if (isMissing(error)) {
                return 0;
            }
            throw error;
        }
        let deleted = 0;
        for (const shard of shards) {
            const shardDir = path.join(this.dir, shard);
            let names: string[];
            try {
                names = await fs.promises.readdir(shardDir);
            } catch {
                continue;
            }
            for (const name of names) {
                const isTemp = name.endsWith(TEMP_SUFFIX);
                if (!isTemp && live.has(name)) {
                    continue;
                }
                if (!isTemp) {
                    await this.hooks?.beforeUnlink?.(name);
                }
                const file = path.join(shardDir, name);
                try {
                    const stat = await fs.promises.stat(file);
                    if (minAgeMs > 0 && Date.now() - stat.mtimeMs < minAgeMs) {
                        continue;
                    }
                    await fs.promises.unlink(file);
                    if (!isTemp) {
                        deleted++;
                    }
                } catch (error) {
                    if (!isMissing(error)) {
                        throw error;
                    }
                }
            }
        }
        return deleted;
    }

    private blobPath(id: string): string {
        return path.join(this.dir, id.slice(0, 2), id);
    }
}
