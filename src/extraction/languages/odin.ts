import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, ImportInfo, LanguageExtractor } from '../tree-sitter-types';

function procedureNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'procedure' || node.type === 'procedure_do_return') return node;
  return node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'procedure' || child.type === 'procedure_do_return',
  ) ?? null;
}

function procedureReturnType(node: SyntaxNode): SyntaxNode | null {
  const procedure = procedureNode(node);
  return procedure ? getChildByField(procedure, 'return_type') : null;
}

function declarationName(node: SyntaxNode): SyntaxNode | null {
  return getChildByField(node, 'name')
    ?? node.namedChildren.find((child) => child.type === 'identifier')
    ?? null;
}

function normalizeReturnType(node: SyntaxNode, source: string): string | undefined {
  let text = getNodeText(node, source).trim();
  if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  const first = text.split(',')[0]?.trim() ?? '';
  const colon = first.lastIndexOf(':');
  const type = (colon >= 0 ? first.slice(colon + 1) : first)
    .replace(/^\^+/, '')
    .replace(/^\.\./, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
  const name = type.split('.').pop()?.trim();
  return name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : undefined;
}

function extractOdinField(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'field') return false;

  for (const child of node.namedChildren) {
    if (child.type === 'type') break;
    if (child.type === 'identifier') {
      ctx.createNode('field', getNodeText(child, ctx.source), child, {
        signature: getNodeText(node, ctx.source).trim(),
      });
    }
  }
  return true;
}

function extractAggregate(
  node: SyntaxNode,
  kind: 'struct' | 'union' | 'enum',
  ctx: ExtractorContext,
): boolean {
  const nameNode = declarationName(node);
  if (!nameNode) return true;
  const aggregate = ctx.createNode(kind, getNodeText(nameNode, ctx.source), node);
  if (!aggregate) return true;

  ctx.pushScope(aggregate.id);
  if (kind === 'struct') {
    for (const child of node.namedChildren) {
      if (child.type === 'field') ctx.visitNode(child);
    }
  } else if (kind === 'enum') {
    let inBody = false;
    let memberStart = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.text === '{') {
        inBody = true;
        memberStart = true;
        continue;
      }
      if (!inBody || child.text === '}') continue;
      if (child.text === ',') {
        memberStart = true;
      } else if (memberStart && child.type === 'identifier') {
        ctx.createNode('enum_member', getNodeText(child, ctx.source), child);
        memberStart = false;
      }
    }
  }
  ctx.popScope();
  return true;
}

function extractBitField(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = declarationName(node);
  if (!nameNode) return true;
  const aggregate = ctx.createNode('struct', getNodeText(nameNode, ctx.source), node);
  if (!aggregate) return true;

  ctx.pushScope(aggregate.id);
  let inBody = false;
  let memberStart = false;
  let memberName: SyntaxNode | null = null;
  const createMember = (endIndex: number) => {
    if (!memberName) return;
    const signature = ctx.source.slice(memberName.startIndex, endIndex).trim();
    ctx.createNode('field', getNodeText(memberName, ctx.source), memberName, { signature });
    memberName = null;
  };

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.text === '{') {
      inBody = true;
      memberStart = true;
      continue;
    }
    if (!inBody) continue;
    if (child.text === ',' || child.text === '}') {
      createMember(child.startIndex);
      memberStart = child.text === ',';
      if (child.text === '}') break;
      continue;
    }
    if (memberStart && child.type === 'identifier') {
      memberName = child;
      memberStart = false;
    }
  }
  ctx.popScope();
  return true;
}

function declarationNames(node: SyntaxNode): SyntaxNode[] {
  const names: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.text === ':' || child.text === ':=' || child.text === '::' || child.text === '=') break;
    if (child.type === 'identifier') names.push(child);
  }
  return names;
}

function extractVariable(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const names = node.type === 'const_type_declaration'
    ? [declarationName(node)].filter((name): name is SyntaxNode => !!name)
    : declarationNames(node);
  if (names.length === 0) return false;

  const kind = node.type === 'const_declaration' || node.type === 'const_type_declaration'
    ? 'constant'
    : 'variable';
  const signature = getNodeText(node, ctx.source).trim().slice(0, 100);
  for (const name of names) {
    ctx.createNode(kind, getNodeText(name, ctx.source), name, { signature });
  }
  return true;
}

function extractOdinMemberCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const call = node.namedChildren.find((child) => child.type === 'call_expression');
  if (!call) return false;
  const receiver = node.namedChildren.find((child) => child !== call);
  const functionNode = getChildByField(call, 'function');
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!receiver || !functionNode || !parentId) return false;

  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: `${getNodeText(receiver, ctx.source)}.${getNodeText(functionNode, ctx.source)}`,
    referenceKind: 'calls',
    line: call.startPosition.row + 1,
    column: call.startPosition.column,
    filePath: ctx.filePath,
    language: 'odin',
  });

  const argumentsNode = getChildByField(call, 'arguments');
  if (argumentsNode) ctx.visitNode(argumentsNode);
  return true;
}

function extractOdinSelectorCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const receiver = getChildByField(node, 'receiver');
  const call = getChildByField(node, 'call');
  const functionNode = call ? getChildByField(call, 'function') : null;
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!receiver || !call || !functionNode || !parentId) return false;

  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: `${getNodeText(receiver, ctx.source)}.${getNodeText(functionNode, ctx.source)}`,
    referenceKind: 'calls',
    line: call.startPosition.row + 1,
    column: call.startPosition.column,
    filePath: ctx.filePath,
    language: 'odin',
  });

  const argumentsNode = getChildByField(call, 'arguments');
  if (argumentsNode) ctx.visitNode(argumentsNode);
  return true;
}

function extractOdinCall(node: SyntaxNode, source: string): string | undefined {
  if (node.type === 'member_expression') {
    const call = node.namedChildren.find((child) => child.type === 'call_expression');
    const receiver = node.namedChildren.find((child) => child !== call);
    const functionNode = call ? getChildByField(call, 'function') : null;
    if (call && receiver && functionNode) {
      return `${getNodeText(receiver, source)}.${getNodeText(functionNode, source)}`;
    }
    return undefined;
  }
  if (node.type === 'selector_call_expression') {
    const receiver = getChildByField(node, 'receiver');
    const call = getChildByField(node, 'call');
    const functionNode = call ? getChildByField(call, 'function') : null;
    return receiver && functionNode
      ? `${getNodeText(receiver, source)}.${getNodeText(functionNode, source)}`
      : undefined;
  }
  if (
    node.type !== 'call_expression' ||
    node.parent?.type === 'member_expression' ||
    node.parent?.type === 'selector_call_expression'
  ) return undefined;
  const functionNode = getChildByField(node, 'function');
  return functionNode ? getNodeText(functionNode, source) : undefined;
}

export const odinExtractor: LanguageExtractor = {
  functionTypes: ['procedure_declaration'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_declaration', 'bit_field_declaration'],
  unionTypes: ['union_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: [],
  variableTypes: [
    'variable_declaration',
    'var_declaration',
    'const_declaration',
    'const_type_declaration',
  ],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  packageTypes: ['package_declaration'],
  extractPackage: (node, source) => {
    const name = declarationName(node);
    return name ? getNodeText(name, source) : null;
  },
  resolveName: (node, source) => {
    const name = declarationName(node);
    return name ? getNodeText(name, source).trim() : undefined;
  },
  resolveBody: (node) => {
    const procedure = procedureNode(node);
    return procedure ? getChildByField(procedure, 'body') : null;
  },
  getSignature: (node, source) => {
    const procedure = procedureNode(node);
    if (!procedure) return undefined;
    const parameters = getChildByField(procedure, 'parameters');
    const returnType = getChildByField(procedure, 'return_type');
    const signature = parameters ? getNodeText(parameters, source) : '';
    return returnType ? `${signature} -> ${getNodeText(returnType, source)}` : signature;
  },
  getReturnType: (node, source) => {
    const returnType = procedureReturnType(node);
    return returnType ? normalizeReturnType(returnType, source) : undefined;
  },
  extractBareCall: extractOdinCall,
  isConst: (node) => node.type === 'const_declaration' || node.type === 'const_type_declaration',
  extractImport: (node, source): ImportInfo | null => {
    const pathNode = getChildByField(node, 'path')
      ?? node.namedChildren.find((child) => child.type === 'string');
    if (!pathNode) return null;
    const moduleName = getNodeText(pathNode, source).replace(/^(?:"|')|(?:"|')$/g, '');
    return moduleName ? { moduleName, signature: getNodeText(node, source).trim() } : null;
  },
  visitNode: (node, ctx) => {
    if (node.type === 'member_expression') return extractOdinMemberCall(node, ctx);
    if (node.type === 'selector_call_expression') return extractOdinSelectorCall(node, ctx);
    if (node.type === 'struct_declaration') return extractAggregate(node, 'struct', ctx);
    if (node.type === 'union_declaration') return extractAggregate(node, 'union', ctx);
    if (node.type === 'enum_declaration') return extractAggregate(node, 'enum', ctx);
    if (node.type === 'bit_field_declaration') return extractBitField(node, ctx);
    if (node.type === 'field') return extractOdinField(node, ctx);
    if (
      node.type === 'variable_declaration' ||
      node.type === 'var_declaration' ||
      node.type === 'const_declaration' ||
      node.type === 'const_type_declaration'
    ) {
      return extractVariable(node, ctx);
    }
    return false;
  },
};
