/**
 * Fitness function (doc 07 §9, rule 2): core modules never name a concrete provider.
 * A provider name in a string literal means core logic is branching on a vendor instead of
 * asking for a capability. Mapping files under `infrastructure/` are exempt via the ESLint config.
 */
export const PROVIDER_NAMES = [
  'github',
  'gitlab',
  'azure',
  'n8n',
  'anthropic',
  'claude',
  'gemini',
  'openai',
  'playwright',
];

const PATTERN = new RegExp(`(^|[^a-z0-9])(${PROVIDER_NAMES.join('|')})([^a-z0-9]|$)`, 'i');

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow provider names in string literals inside core modules.' },
    schema: [],
    messages: {
      provider:
        'Provider name "{{name}}" in core code. Ask for a capability through a port, or move the mapping to an infrastructure/ file.',
    },
  },
  create(context) {
    const check = (node, value) => {
      if (typeof value !== 'string') return;
      const m = PATTERN.exec(value);
      if (m) context.report({ node, messageId: 'provider', data: { name: m[2] } });
    };
    const isModuleSpecifier = (node) =>
      node.parent &&
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(
        node.parent.type,
      );
    return {
      Literal(node) {
        // Import paths are checked by dependency-cruiser, not here.
        if (!isModuleSpecifier(node)) check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
    };
  },
};

export default rule;
