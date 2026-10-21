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

import type { SemanticDiff } from "@wso2/ballerina-core";

// The real barrel pulls in the LS websocket client, which jest can't load.
jest.mock("@wso2/ballerina-core", () => ({
    NodeKindEnum: {
        MODULE_FUNCTION: 0,
        OBJECT_FUNCTION: 1,
        TYPE_DEFINITION: 2,
        DATA_MAPPING_FUNCTION: 3,
        MODULE_VARIABLE: 4,
        CONSTANT: 5,
        LISTENER: 6,
        CLASS_DEFINITION: 7,
        ENUM_DECLARATION: 8,
        IMPORT_DECLARATION: 9,
    },
}));

import { getNodeKindLabel } from "./nodeKindLabels";

const OBJECT_FUNCTION = 1;

// Each OBJECT_FUNCTION metadata shape the LS sends, with its expected label.
const OBJECT_FUNCTION_CASES: Array<{ shape: string; metadata: SemanticDiff["metadata"]; label: string }> = [
    {
        shape: "resource function",
        metadata: { accessor: "get", servicePath: "/api", resourcePath: "data" },
        label: "resource",
    },
    {
        shape: "resource function on the service root",
        metadata: { accessor: "get", servicePath: "/api", resourcePath: "." },
        label: "resource",
    },
    {
        shape: "remote function",
        metadata: { name: "onMessage", servicePath: "", functionKind: "remote" },
        label: "remote",
    },
    {
        shape: "plain service method",
        metadata: { name: "format", servicePath: "" },
        label: "method",
    },
    {
        shape: "class method",
        metadata: { name: "process" },
        label: "method",
    },
    {
        // issue-2263: an older LS sent the function name as the accessor.
        shape: "remote function from an older LS",
        metadata: { accessor: "onMessage", servicePath: "", resourcePath: "" },
        label: "remote",
    },
];

describe("getNodeKindLabel", () => {
    it.each(OBJECT_FUNCTION_CASES)("labels a $shape as '$label'", ({ metadata, label }) => {
        expect(getNodeKindLabel(OBJECT_FUNCTION, metadata)).toBe(label);
    });

    it("labels an OBJECT_FUNCTION without metadata as a method", () => {
        expect(getNodeKindLabel(OBJECT_FUNCTION)).toBe("method");
    });

    it("falls back to 'component' for an unknown node kind", () => {
        expect(getNodeKindLabel(999)).toBe("component");
    });
});
