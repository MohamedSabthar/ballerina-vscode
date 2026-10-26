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

// L2: ApprovalEditor, the agent-tool "Requires Approval" control. Renders the real editor via
// formHarness and asserts its states: the add button, the add form (inline and as a panel over
// the side panel), the attached function with Open / Remove, and the values it writes to the form.

import React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ApprovalFieldConfig, FormField } from "../components/Form/types";
import { renderWithForm } from "./formHarness";
import { ApprovalEditor } from "../components/editors/ApprovalEditor";

const PARAMS = [
    { type: "string", name: "to" },
    { type: "string", name: "subject" },
];

function approvalField(value: boolean, overrides: Partial<ApprovalFieldConfig> = {}): FormField {
    return {
        key: "requiresApproval",
        label: "Requires Approval",
        type: "AGENT_TOOL_APPROVAL",
        value,
        optional: true,
        editable: true,
        enabled: true,
        documentation: "Pause this tool before it runs and wait for human approval.",
        types: [{ fieldType: "AGENT_TOOL_APPROVAL", selected: false }],
        approvalConfig: {
            functionKey: "approvalFunction",
            generateKey: "generateApprovalFunction",
            initialFunction: "",
            presentation: "inline",
            defaultFunctionName: "sendEmailApproval",
            toolName: "sendEmailTool",
            getToolParameters: (values) => values.params ?? PARAMS,
            ...overrides,
        },
    } as FormField;
}

function renderApproval(value: boolean, overrides: Partial<ApprovalFieldConfig> = {}, values: Record<string, any> = {}) {
    return renderWithForm(<ApprovalEditor field={approvalField(value, overrides)} />, {
        defaultValues: { requiresApproval: value, ...values },
    });
}

describe("ApprovalEditor", () => {
    it("shows no approval function controls while the gate is off", () => {
        const { container } = renderApproval(false);
        expect(container.textContent).toContain("Requires Approval");
        expect(container.textContent).not.toContain("Add Approval Function");
    });

    it("offers only an add button when the gate is on and no function is attached", () => {
        const { container } = renderApproval(true);
        expect(container.textContent).toContain("Add Approval Function");
        expect(screen.queryByTestId("approval-function-attached")).toBeNull();
    });

    it("adds a new function inline with the tool's parameters and marks it for generation", async () => {
        const { getForm } = renderApproval(true);
        fireEvent.click(screen.getByText("Add Approval Function"));

        expect(screen.getByText("New Approval Function")).toBeTruthy();
        const rows = screen.getAllByTestId("approval-function-param").map((row) => row.textContent);
        expect(rows).toEqual(["stringto", "stringsubject"]);

        await act(async () => {
            fireEvent.click(screen.getByText("Add"));
        });

        await waitFor(() => expect(screen.getByTestId("approval-function-attached").textContent)
            .toContain("sendEmailApproval"));
        expect(getForm().getValues("approvalFunction")).toBe("sendEmailApproval");
        expect(getForm().getValues("generateApprovalFunction")).toBe(true);
        expect(screen.getByText("Created when you save the tool.")).toBeTruthy();
        // A function that only exists after save can't be opened yet.
        expect(screen.queryByLabelText("Open sendEmailApproval")).toBeNull();
    });

    it("keeps the add form open with an error when the name is taken", async () => {
        const isNameTaken = jest.fn().mockResolvedValue(true);
        const { getForm } = renderApproval(true, { isNameTaken });
        fireEvent.click(screen.getByText("Add Approval Function"));
        await act(async () => {
            fireEvent.click(screen.getByText("Add"));
        });

        expect(isNameTaken).toHaveBeenCalledWith("sendEmailApproval");
        expect(screen.queryByTestId("approval-function-attached")).toBeNull();
        expect(getForm().getValues("approvalFunction")).toBe("");
    });

    it("opens the add form as a panel over the side panel in view presentation", () => {
        renderApproval(true, { presentation: "view" });
        fireEvent.click(screen.getByText("Add Approval Function"));
        expect(document.body.textContent).toContain("Generated from the tool's parameters.");
        expect(screen.queryByText("New Approval Function")).toBeNull();
    });

    it("shows an existing function with Open and Remove", async () => {
        const onOpenFunction = jest.fn();
        const { getForm } = renderApproval(true, { initialFunction: "isHighValue", onOpenFunction });

        await waitFor(() => expect(screen.getByTestId("approval-function-attached").textContent)
            .toContain("isHighValue"));
        fireEvent.click(screen.getByLabelText("Open isHighValue"));
        expect(onOpenFunction).toHaveBeenCalledWith("isHighValue");

        fireEvent.click(screen.getByLabelText("Remove approval function"));
        await waitFor(() => expect(screen.queryByTestId("approval-function-attached")).toBeNull());
        expect(getForm().getValues("approvalFunction")).toBe("");
        expect(screen.getByText("Add Approval Function")).toBeTruthy();
    });

    it("tells the user an existing function will be updated when the tool's parameters change", async () => {
        const { getForm } = renderApproval(true, { initialFunction: "isHighValue" }, { params: PARAMS });
        await waitFor(() => expect(screen.getByTestId("approval-function-attached")).toBeTruthy());
        expect(screen.queryByTestId("approval-function-sync-note")).toBeNull();

        act(() => {
            getForm().setValue("params", [...PARAMS, { type: "string[]", name: "cc" }]);
        });
        await waitFor(() => expect(screen.getByTestId("approval-function-sync-note").textContent)
            .toContain("isHighValue will be updated to match when you save"));
    });
    it("warns when the attached function was edited out of step with the tool", async () => {
        const getFunctionInfo = jest.fn().mockResolvedValue({
            params: [{ type: "string", name: "to" }], usedBy: ["sendEmailTool"],
        });
        renderApproval(true, { initialFunction: "isHighValue", getFunctionInfo });

        await waitFor(() => expect(screen.getByTestId("approval-function-sync-note").textContent)
            .toContain("isHighValue doesn't match this tool's parameters. Saving the tool will update it to match."));
        expect(getFunctionInfo).toHaveBeenCalledWith("isHighValue");
    });

    it("stays quiet when the attached function matches the tool", async () => {
        const getFunctionInfo = jest.fn().mockResolvedValue({
            params: [{ type: "string", name: "to" }, { type: " string ", name: "subject" }], usedBy: ["sendEmailTool"],
        });
        renderApproval(true, { initialFunction: "isHighValue", getFunctionInfo });
        await waitFor(() => expect(getFunctionInfo).toHaveBeenCalled());
        await act(async () => undefined);
        expect(screen.queryByTestId("approval-function-sync-note")).toBeNull();
    });

    it("says a shared function won't be updated", async () => {
        const getFunctionInfo = jest.fn().mockResolvedValue({
            params: [{ type: "string", name: "to" }], usedBy: ["sendEmailTool", "refundTool"],
        });
        renderApproval(true, { initialFunction: "isHighValue", getFunctionInfo });
        await waitFor(() => expect(screen.getByTestId("approval-function-sync-note").textContent)
            .toContain("saving won't update it because refundTool also uses it"));
    });
});
