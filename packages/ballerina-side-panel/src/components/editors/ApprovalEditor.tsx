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

import React, { useEffect, useMemo, useState } from "react";
import { useFormState } from "react-hook-form";
import { createPortal } from "react-dom";
import styled from "@emotion/styled";
import { Button, CheckBoxGroup, Codicon, FormCheckBox, LinkButton, TextField, ThemeColors } from "@wso2/ui-toolkit";
import { ApprovalFieldConfig, ApprovalFunctionParam, FormField } from "../Form/types";
import { indentedFieldStyles } from "../Form/styles";
import { useFormContext } from "../../context";
import { PanelContainer } from "../Panel";
import { WarningBanner } from "../Form/WarningBanner";

// Same layout as CheckBoxConditionalEditor, which this field replaces for the agent-tool
// "Requires Approval" gate: a checkbox row, then an indented section revealed while checked.
const Form = styled.div`
    display: grid;
    gap: 20px;
    width: 100%;
    align-items: start;
`;

const FormSection = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
    ${indentedFieldStyles}
`;

const BoxGroup = styled.div`
    display: flex;
    flex-direction: row;
    width: 100%;
    align-items: flex-start;
`;

const LabelGroup = styled.div`
    display: flex;
    flex-direction: column;
    gap: 2px;
`;

const Label = styled.div`
    font-family: var(--font-family);
    color: var(--vscode-editor-foreground);
    text-align: left;
`;

const Description = styled.div`
    font-family: var(--font-family);
    color: var(--vscode-list-deemphasizedForeground);
    text-align: left;
`;

const AttachedRow = styled.div`
    display: flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    margin-top: 4px;
    padding: 0 2px 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
`;

const AttachedName = styled.span`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const IconButton = styled.button`
    flex: none;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
    &:hover {
        background: var(--vscode-toolbar-hoverBackground);
    }
    &:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
    }
`;

const Note = styled.div`
    display: flex;
    gap: 6px;
    align-items: flex-start;
    margin-top: 6px;
    color: var(--vscode-list-deemphasizedForeground);
`;

const InlineCard = styled.div`
    margin-top: 6px;
    padding: 16px;
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    background: ${ThemeColors.SURFACE_DIM};
`;

const AddFormBody = styled.div`
    display: flex;
    flex-direction: column;
    gap: 20px;
`;

const PanelBody = styled.div`
    padding: 16px;
    overflow: auto;
    height: calc(100vh - 60px);
    box-sizing: border-box;
`;

const ReadonlyRow = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 6px;
    box-sizing: border-box;
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    cursor: not-allowed;
`;

const Chip = styled.span`
    display: inline-flex;
    align-items: center;
    min-height: 18px;
    padding: 0 8px;
    font-size: 12px;
    border-radius: 4px;
    background: ${ThemeColors.SURFACE_CONTAINER};
    border: 1px solid ${ThemeColors.OUTLINE_VARIANT};
    color: ${ThemeColors.ON_SURFACE};
`;

const ButtonRow = styled.div`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
`;

const ErrorText = styled.div`
    color: var(--vscode-errorForeground);
`;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const APPROVAL_FUNCTION_LABEL = "Approval Function";
export const APPROVAL_FUNCTION_DESCRIPTION =
    "Optional. Decides per call whether approval is needed. Without one, every call pauses for approval.";

function paramsSignature(params: ApprovalFunctionParam[]): string {
    return params.map((param) => `${param.type.replace(/\s+/g, "")} ${param.name}`).join(",");
}

function isChecked(value: unknown): boolean {
    return value === true || value === "true";
}

interface AddApprovalFunctionFormProps {
    defaultName: string;
    toolName?: string;
    isNameTaken?: (name: string) => Promise<boolean>;
    params: ApprovalFunctionParam[];
    onCancel: () => void;
    onAdd: (name: string) => void;
}

export function AddApprovalFunctionForm(props: AddApprovalFunctionFormProps) {
    const { defaultName, toolName, isNameTaken, params, onCancel, onAdd } = props;
    const [name, setName] = useState<string>(defaultName);
    const [error, setError] = useState<string>("");
    const [checking, setChecking] = useState<boolean>(false);

    const validate = (value: string): string => {
        const trimmed = value.trim();
        if (!trimmed) return "Enter a name for the approval function.";
        if (!IDENTIFIER.test(trimmed)) return "Use letters, digits and underscores, starting with a letter.";
        if (toolName && trimmed === toolName) return "Use a different name from the tool.";
        return "";
    };

    const handleAdd = async () => {
        const trimmed = name.trim();
        const message = validate(trimmed);
        if (message) {
            setError(message);
            return;
        }
        if (isNameTaken) {
            setChecking(true);
            try {
                if (await isNameTaken(trimmed)) {
                    setError(`A function named '${trimmed}' already exists. Choose another name.`);
                    return;
                }
            } finally {
                setChecking(false);
            }
        }
        onAdd(trimmed);
    };

    const toolLabel = toolName ? `each ${toolName} call` : "each call to this tool";

    return (
        <AddFormBody>
            <Description>
                Runs before {toolLabel} with the same arguments. Return true to pause for human approval,
                false to let the call run.
            </Description>
            <TextField
                id="approval-function-name"
                label="Function Name"
                required
                description="Generated from the tool; you can change it."
                value={name}
                errorMsg={error || undefined}
                onTextChange={(value: string) => {
                    setName(value);
                    setError(validate(value));
                }}
            />
            <LabelGroup>
                <Label>Parameters</Label>
                <Description>Generated from the tool's parameters. They can't be edited here.</Description>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                    {params.length === 0 && <Description>This tool has no parameters.</Description>}
                    {params.map((param) => (
                        <ReadonlyRow key={param.name} data-testid="approval-function-param">
                            <Chip>{param.type}</Chip>
                            {param.name}
                        </ReadonlyRow>
                    ))}
                </div>
            </LabelGroup>
            <LabelGroup>
                <Label>Return Type</Label>
                <Description>Approval functions always return boolean.</Description>
                <ReadonlyRow style={{ marginTop: 4 }}><Chip>boolean</Chip></ReadonlyRow>
            </LabelGroup>
            <ButtonRow>
                <Button id="approval-function-add-cancel" appearance="secondary" onClick={onCancel}>Cancel</Button>
                <Button
                    id="approval-function-add-confirm"
                    appearance="primary"
                    onClick={handleAdd}
                    disabled={checking || Boolean(validate(name))}
                >
                    Add
                </Button>
            </ButtonRow>
        </AddFormBody>
    );
}

interface ApprovalEditorProps {
    field: FormField;
}

export function ApprovalEditor(props: ApprovalEditorProps) {
    const { field } = props;
    const config = field.approvalConfig as ApprovalFieldConfig;
    const { form } = useFormContext();
    const { register, control, watch, setValue, getValues } = form;
    const [adding, setAdding] = useState<boolean>(false);

    useEffect(() => {
        register(config.functionKey);
        register(config.generateKey);
        if (getValues(config.functionKey) === undefined) {
            setValue(config.functionKey, config.initialFunction ?? "");
            setValue(config.generateKey, false);
        }
    }, [config.functionKey, config.generateKey, config.initialFunction]);

    const values = watch();
    const checked = isChecked(values[field.key]);
    const functionName = typeof values[config.functionKey] === "string" ? values[config.functionKey].trim() : "";
    const isNew = isChecked(values[config.generateKey]);
    const params = useMemo(() => config.getToolParameters(values), [values, config]);

    // The tool's parameters as the form loaded them, to tell the user that saving will also update an
    // existing approval function whose signature no longer matches. Form loads its values with reset()
    // after this editor mounts, so compare against the form's default values rather than a snapshot.
    const { defaultValues } = useFormState({ control });
    const paramsChanged = useMemo(
        () => paramsSignature(config.getToolParameters(defaultValues ?? {})) !== paramsSignature(params),
        [defaultValues, params, config]
    );

    // The attached function as it is in source, to catch one that was edited out of step with the tool.
    const [info, setInfo] = useState<{ name: string; params: ApprovalFunctionParam[]; usedBy: string[] } | null>(null);
    useEffect(() => {
        if (!functionName || isNew || !config.getFunctionInfo) {
            setInfo(null);
            return;
        }
        let cancelled = false;
        config.getFunctionInfo(functionName).then((result) => {
            if (!cancelled) {
                setInfo(result ? { name: functionName, ...result } : null);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [functionName, isNew, config.getFunctionInfo]);

    const attach = (name: string) => {
        setValue(config.functionKey, name, { shouldDirty: true });
        setValue(config.generateKey, true, { shouldDirty: true });
        setAdding(false);
    };

    const remove = () => {
        setValue(config.functionKey, "", { shouldDirty: true });
        setValue(config.generateKey, false, { shouldDirty: true });
    };

    const resolve = (value: ApprovalFieldConfig["toolName"]): string | undefined =>
        typeof value === "function" ? value(values) : value;
    const toolName = resolve(config.toolName)?.trim() || undefined;

    const syncWarning = ((): string | undefined => {
        if (isNew || !functionName) return undefined;
        const changed = `Parameters changed. ${functionName} will be updated to match when you save.`;
        const current = info?.name === functionName ? info : null;
        if (!current) return paramsChanged ? changed : undefined;
        if (paramsSignature(current.params) === paramsSignature(params)) return undefined;
        // The language server leaves a function that other tools also use untouched.
        const others = current.usedBy.filter((tool) => tool !== toolName);
        if (others.length > 0) {
            return `${functionName} doesn't match this tool's parameters, and saving won't update it because `
                + `${others.join(", ")} also uses it.`;
        }
        return paramsChanged
            ? changed
            : `${functionName} doesn't match this tool's parameters. Saving the tool will update it to match.`;
    })();

    const addForm = (
        <AddApprovalFunctionForm
            defaultName={resolve(config.defaultFunctionName) ?? ""}
            toolName={toolName}
            isNameTaken={config.isNameTaken}
            params={params}
            onCancel={() => setAdding(false)}
            onAdd={attach}
        />
    );

    return (
        <Form>
            <CheckBoxGroup containerSx={{ width: "100%" }}>
                <BoxGroup data-testid="approval-required">
                    <FormCheckBox
                        name={field.key}
                        {...register(field.key, { value: isChecked(field.value) })}
                        control={control as any}
                    />
                    <LabelGroup>
                        <Label>{field.label}</Label>
                        <Description>{field.documentation}</Description>
                    </LabelGroup>
                </BoxGroup>
            </CheckBoxGroup>
            {checked && (
                <FormSection>
                    <Label>{APPROVAL_FUNCTION_LABEL}</Label>
                    <Description>{APPROVAL_FUNCTION_DESCRIPTION}</Description>
                    {functionName ? (
                        <>
                            <AttachedRow data-testid="approval-function-attached">
                                <AttachedName title={functionName}>{functionName}</AttachedName>
                                {!isNew && config.onOpenFunction && (
                                    <IconButton
                                        type="button"
                                        data-testid="approval-function-open"
                                        aria-label={`Open ${functionName}`}
                                        title="Open in flow diagram"
                                        onClick={() => config.onOpenFunction?.(functionName)}
                                    >
                                        <Codicon name="go-to-file" />
                                    </IconButton>
                                )}
                                <IconButton
                                    type="button"
                                    data-testid="approval-function-remove"
                                    aria-label="Remove approval function"
                                    title="Remove"
                                    onClick={remove}
                                >
                                    <Codicon name="trash" />
                                </IconButton>
                            </AttachedRow>
                            {isNew && <Note>Created when you save the tool.</Note>}
                            {syncWarning && (
                                <div data-testid="approval-function-sync-note" style={{ marginTop: 6 }}>
                                    <WarningBanner warningMsg={syncWarning} />
                                </div>
                            )}
                        </>
                    ) : adding && config.presentation === "inline" ? (
                        <InlineCard>
                            <Label style={{ fontWeight: 600, marginBottom: 12 }}>New Approval Function</Label>
                            {addForm}
                        </InlineCard>
                    ) : (
                        <LinkButton id="approval-function-add" onClick={() => setAdding(true)} sx={{ marginTop: 4 }}>
                            <Codicon name="add" />
                            Add {APPROVAL_FUNCTION_LABEL}
                        </LinkButton>
                    )}
                    {invalidNameError(functionName)}
                </FormSection>
            )}
            {adding && config.presentation === "view" && createPortal(
                <PanelContainer
                    show
                    title={`Add ${APPROVAL_FUNCTION_LABEL}`}
                    onBack={() => setAdding(false)}
                    onClose={() => setAdding(false)}
                >
                    <PanelBody>{addForm}</PanelBody>
                </PanelContainer>,
                document.body
            )}
        </Form>
    );
}

// The annotation slot takes a bare function reference; a value that isn't one (e.g. typed into an
// older picker) can't be opened or synced, so call it out instead of failing silently.
function invalidNameError(functionName: string) {
    if (!functionName || IDENTIFIER.test(functionName)) return null;
    return <ErrorText>'{functionName}' is not a valid function name.</ErrorText>;
}
