/*
 *  Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com)
 *
 *  WSO2 LLC. licenses this file to you under the Apache License,
 *  Version 2.0 (the "License"); you may not use this file except
 *  in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

package io.ballerina.modelgenerator.commons;

import io.ballerina.compiler.api.SemanticModel;
import io.ballerina.compiler.api.symbols.FunctionSymbol;
import io.ballerina.compiler.api.symbols.Symbol;
import io.ballerina.compiler.api.symbols.SymbolKind;
import io.ballerina.compiler.syntax.tree.ClassDefinitionNode;
import io.ballerina.compiler.syntax.tree.FunctionDefinitionNode;
import io.ballerina.compiler.syntax.tree.FunctionSignatureNode;
import io.ballerina.compiler.syntax.tree.MetadataNode;
import io.ballerina.compiler.syntax.tree.ModuleMemberDeclarationNode;
import io.ballerina.compiler.syntax.tree.ModulePartNode;
import io.ballerina.compiler.syntax.tree.Node;
import io.ballerina.compiler.syntax.tree.NonTerminalNode;
import io.ballerina.compiler.syntax.tree.ParameterNode;
import io.ballerina.compiler.syntax.tree.RequiredParameterNode;
import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.compiler.syntax.tree.Token;
import io.ballerina.projects.Document;
import io.ballerina.tools.diagnostics.Location;
import io.ballerina.tools.text.LinePosition;
import io.ballerina.tools.text.LineRange;
import org.ballerinalang.langserver.common.utils.CommonUtil;
import org.ballerinalang.langserver.commons.workspace.WorkspaceManager;
import org.eclipse.lsp4j.Position;
import org.eclipse.lsp4j.Range;
import org.eclipse.lsp4j.TextEdit;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Keeps the approval function referenced by an {@code @ai:AgentTool {requiresApproval: <fn>}} annotation in step
 * with its tool. The {@code ai} module binds a tool call's arguments to that function by name, and its compiler
 * plugin (AI_111) requires the same parameters as the tool, minus a leading {@code ai:Context}, returning
 * {@code boolean}.
 *
 * <p>When a tool is saved, the approval function's parameter list is rewritten to match the tool's (name, body,
 * docs and qualifiers are kept), or a stub is generated when the referenced function doesn't exist yet. A function
 * that is also referenced from anywhere else is never rewritten, since that would break the other reference.</p>
 *
 * @since 2.0.0
 */
public final class ApprovalFunctionSync {

    private static final Pattern REQUIRES_APPROVAL =
            Pattern.compile("\\brequiresApproval\\s*:\\s*('?[A-Za-z_][A-Za-z0-9_]*)(?=\\s*(?:[,}]|$))");
    private static final String AI_CONTEXT_TYPE = "ai:Context";

    /**
     * A tool or approval-function parameter.
     *
     * @param type the parameter's type as written in source
     * @param name the parameter name
     */
    public record Param(String type, String name) {

        String declaration() {
            return type + " " + name;
        }
    }

    private ApprovalFunctionSync() {
    }

    /**
     * Returns the approval function an {@code @ai:AgentTool} annotation refers to, if it refers to one by a plain
     * name. {@code true}/{@code false} and qualified references ({@code mod:fn}) yield nothing.
     *
     * @param annotations the annotation source attached to the tool
     * @return the function name
     */
    public static Optional<String> approvalFunctionName(String annotations) {
        if (annotations == null || !annotations.contains("AgentTool")) {
            return Optional.empty();
        }
        Matcher matcher = REQUIRES_APPROVAL.matcher(annotations);
        if (!matcher.find()) {
            return Optional.empty();
        }
        String name = matcher.group(1);
        if (name.equals("true") || name.equals("false")) {
            return Optional.empty();
        }
        return Optional.of(name);
    }

    /**
     * Names of the agent tools whose {@code @ai:AgentTool} annotation names the given function as their approval
     * function, across the given module documents. Covers module-level tools and tools defined inside classes.
     *
     * @param roots        root nodes of the module's documents
     * @param functionName the approval function's name
     * @return tool names in document order; empty when the function isn't an approval function
     */
    public static List<String> toolsUsing(Collection<ModulePartNode> roots, String functionName) {
        List<String> tools = new ArrayList<>();
        for (ModulePartNode root : roots) {
            for (ModuleMemberDeclarationNode member : root.members()) {
                if (member.kind() == SyntaxKind.FUNCTION_DEFINITION) {
                    addIfGated(tools, (FunctionDefinitionNode) member, functionName);
                } else if (member.kind() == SyntaxKind.CLASS_DEFINITION) {
                    for (Node classMember : ((ClassDefinitionNode) member).members()) {
                        if (classMember.kind() == SyntaxKind.OBJECT_METHOD_DEFINITION) {
                            addIfGated(tools, (FunctionDefinitionNode) classMember, functionName);
                        }
                    }
                }
            }
        }
        return tools;
    }

    /**
     * Whether a function is referenced anywhere other than its own definition and the given number of
     * {@code requiresApproval} annotation fields, such as a call from business logic or an {@code ai:ToolConfig}.
     * Such a function is never deleted along with the tools that used it.
     *
     * @param semanticModel the function's semantic model
     * @param function      the function definition
     * @param approvalUses  how many agent tool annotations name the function
     * @return true when something else refers to the function
     */
    public static boolean referencedOutsideApprovals(SemanticModel semanticModel, FunctionDefinitionNode function,
                                                     int approvalUses) {
        Optional<Symbol> symbol = semanticModel.symbol(function);
        if (symbol.isEmpty()) {
            return true;
        }
        Optional<Location> definition = symbol.get().getLocation();
        long references = semanticModel.references(symbol.get()).stream()
                .filter(reference -> definition.isEmpty()
                        || !definition.get().lineRange().equals(reference.lineRange()))
                .count();
        return references > approvalUses;
    }

    private static void addIfGated(List<String> tools, FunctionDefinitionNode function, String functionName) {
        Optional<MetadataNode> metadata = function.metadata();
        if (metadata.isEmpty()) {
            return;
        }
        Optional<String> approvalFunction = approvalFunctionName(metadata.get().toSourceCode());
        if (approvalFunction.isPresent() && stripQuote(approvalFunction.get()).equals(stripQuote(functionName))) {
            tools.add(function.functionName().text().trim());
        }
    }

    private static String stripQuote(String name) {
        return name.startsWith("'") ? name.substring(1) : name;
    }

    /**
     * The parameters an approval function must declare for a tool: the tool's own, minus a leading
     * {@code ai:Context}.
     *
     * @param toolParams the tool's parameters in order
     * @return the approval function's parameters
     */
    public static List<Param> approvalParams(List<Param> toolParams) {
        if (!toolParams.isEmpty() && isAiContext(toolParams.get(0).type())) {
            return toolParams.subList(1, toolParams.size());
        }
        return toolParams;
    }

    /**
     * Source of a new approval function stub, matching the one generated when a tool is created.
     *
     * @param name   function name
     * @param params the approval function's parameters
     * @return the function source
     */
    public static String stubSource(String name, List<Param> params) {
        return "isolated function " + name + "(" + declarations(params) + ") returns boolean {"
                + System.lineSeparator()
                + "    // TODO: inspect the proposed arguments and return true to require approval"
                + System.lineSeparator()
                + "    return true;"
                + System.lineSeparator()
                + "}";
    }

    /**
     * Computes the edits that bring the approval function in line with the tool's parameters.
     *
     * @param workspaceManager  workspace manager
     * @param toolFile          file the tool is defined in
     * @param functionName      the approval function's name
     * @param toolParams        the tool's parameters as they will be saved
     * @param toolRange         the tool's current range, used to tell the tool's own reference apart from others;
     *                          {@code null} for a tool not yet in source
     * @param generateIfMissing whether to generate a stub when no function with that name exists
     * @return text edits keyed by file; empty when nothing needs to change
     */
    public static Map<Path, List<TextEdit>> sync(WorkspaceManager workspaceManager, Path toolFile,
                                                  String functionName, List<Param> toolParams, LineRange toolRange,
                                                  boolean generateIfMissing) {
        Map<Path, List<TextEdit>> edits = new HashMap<>();
        Optional<SemanticModel> optSemanticModel = workspaceManager.semanticModel(toolFile);
        if (optSemanticModel.isEmpty()) {
            return edits;
        }
        SemanticModel semanticModel = optSemanticModel.get();
        List<Param> params = approvalParams(toolParams);
        String bareName = functionName.startsWith("'") ? functionName.substring(1) : functionName;

        Optional<FunctionSymbol> optSymbol = findModuleFunction(semanticModel, bareName);
        if (optSymbol.isEmpty()) {
            if (generateIfMissing) {
                stubEdit(workspaceManager, toolFile, functionName, params)
                        .ifPresent(edit -> edits.put(toolFile, new ArrayList<>(List.of(edit))));
            }
            return edits;
        }
        FunctionSymbol symbol = optSymbol.get();
        if (isReferencedElsewhere(semanticModel, symbol, toolFile, toolRange)) {
            return edits;
        }
        Optional<FunctionLocation> optLocation = locate(workspaceManager, toolFile, symbol);
        if (optLocation.isEmpty()) {
            return edits;
        }
        FunctionLocation location = optLocation.get();
        signatureEdit(location.node(), params)
                .ifPresent(edit -> edits.put(location.file(), new ArrayList<>(List.of(edit))));
        return edits;
    }

    /**
     * The edit that rewrites an approval function's parameter list, if it differs from the given parameters.
     *
     * @param function the approval function
     * @param params   the parameters it must declare
     * @return the edit, or empty when the parameters already match
     */
    public static Optional<TextEdit> signatureEdit(FunctionDefinitionNode function, List<Param> params) {
        FunctionSignatureNode signature = function.functionSignature();
        List<String> current = new ArrayList<>();
        for (ParameterNode parameter : signature.parameters()) {
            current.add(normalize(parameter.toSourceCode()));
        }
        List<String> expected = params.stream().map(param -> normalize(param.declaration())).toList();
        if (current.equals(expected)) {
            return Optional.empty();
        }
        LinePosition start = signature.openParenToken().lineRange().endLine();
        LinePosition end = signature.closeParenToken().lineRange().startLine();
        Range range = new Range(new Position(start.line(), start.offset()), new Position(end.line(), end.offset()));
        return Optional.of(new TextEdit(range, declarations(params)));
    }

    /**
     * Reads a function's parameters from its definition.
     *
     * @param function the function
     * @return its parameters in order; parameters without a name are skipped
     */
    public static List<Param> params(FunctionDefinitionNode function) {
        List<Param> params = new ArrayList<>();
        for (ParameterNode parameter : function.functionSignature().parameters()) {
            if (parameter.kind() == SyntaxKind.REQUIRED_PARAM) {
                RequiredParameterNode required = (RequiredParameterNode) parameter;
                Optional<Token> name = required.paramName();
                if (name.isPresent()) {
                    params.add(new Param(required.typeName().toSourceCode().trim(), name.get().text().trim()));
                }
            }
        }
        return params;
    }

    private static Optional<FunctionSymbol> findModuleFunction(SemanticModel semanticModel, String name) {
        for (Symbol symbol : semanticModel.moduleSymbols()) {
            if (symbol.kind() == SymbolKind.FUNCTION && symbol.getName().map(name::equals).orElse(false)) {
                return Optional.of((FunctionSymbol) symbol);
            }
        }
        return Optional.empty();
    }

    // Any reference outside the tool being saved (another tool's annotation, a ToolConfig, a call) means the
    // function serves more than this tool, so its signature is left alone.
    private static boolean isReferencedElsewhere(SemanticModel semanticModel, FunctionSymbol symbol, Path toolFile,
                                                 LineRange toolRange) {
        Optional<Location> definition = symbol.getLocation();
        Path toolFilePath = toolFile.getFileName();
        String toolFileName = toolFilePath == null ? "" : toolFilePath.toString();
        for (Location reference : semanticModel.references(symbol)) {
            LineRange range = reference.lineRange();
            if (definition.isPresent() && definition.get().lineRange().equals(range)) {
                continue;
            }
            boolean inTool = toolRange != null
                    && range.fileName().equals(toolFileName)
                    && range.startLine().line() >= toolRange.startLine().line()
                    && range.endLine().line() <= toolRange.endLine().line();
            if (!inTool) {
                return true;
            }
        }
        return false;
    }

    private record FunctionLocation(Path file, FunctionDefinitionNode node) {
    }

    private static Optional<FunctionLocation> locate(WorkspaceManager workspaceManager, Path toolFile,
                                                     FunctionSymbol symbol) {
        Path parent = toolFile.getParent();
        Optional<Location> location = symbol.getLocation();
        if (parent == null || location.isEmpty()) {
            return Optional.empty();
        }
        Path functionFile = parent.resolve(location.get().lineRange().fileName());
        Optional<Document> document = workspaceManager.document(functionFile);
        if (document.isEmpty()) {
            return Optional.empty();
        }
        Optional<NonTerminalNode> node = CommonUtil.findNode(symbol, document.get().syntaxTree());
        if (node.isEmpty() || node.get().kind() != SyntaxKind.FUNCTION_DEFINITION) {
            return Optional.empty();
        }
        return Optional.of(new FunctionLocation(functionFile, (FunctionDefinitionNode) node.get()));
    }

    private static Optional<TextEdit> stubEdit(WorkspaceManager workspaceManager, Path toolFile, String name,
                                               List<Param> params) {
        Optional<Document> document = workspaceManager.document(toolFile);
        if (document.isEmpty()) {
            return Optional.empty();
        }
        LinePosition end = document.get().syntaxTree().rootNode().lineRange().endLine();
        Position position = new Position(end.line(), end.offset());
        String lineSeparator = System.lineSeparator();
        return Optional.of(new TextEdit(new Range(position, position),
                lineSeparator + stubSource(name, params) + lineSeparator));
    }

    private static boolean isAiContext(String type) {
        return type.replaceAll("\\s", "").equals(AI_CONTEXT_TYPE);
    }

    private static String declarations(List<Param> params) {
        return String.join(", ", params.stream().map(Param::declaration).toList());
    }

    private static String normalize(String source) {
        return source.replaceAll("\\s+", " ").trim();
    }
}
