/**
 * RTL lint (T-P1-14): UI code uses logical direction utilities only, so one layout serves LTR and RTL.
 * Flags physical Tailwind classes (ml-4, pr-2, left-0, text-left, border-l, rounded-r …) in strings.
 */
// One class at a time: optional variants ("md:", "hover:"), optional "-", then a physical utility.
const PHYSICAL =
  /^(?:[a-z0-9-]+:)*-?(?:(?:m|p)[lr]-\S+|(?:left|right)-\S+|border-[lr](?:-\S+)?|rounded-(?:[lr]|t[lr]|b[lr])(?:-\S+)?|scroll-(?:m|p)[lr]-\S+|(?:text|float|clear)-(?:left|right))$/;

const HINT = 'ms-/me-, ps-/pe-, start-/end-, border-s/border-e, rounded-s/rounded-e, text-start/text-end';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow physical left/right utility classes; use logical ones.' },
    schema: [],
    messages: {
      physical: 'Physical direction class "{{cls}}" breaks RTL. Use a logical utility (' + HINT + ').',
    },
  },
  create(context) {
    const check = (node, value) => {
      if (typeof value !== 'string') return;
      for (const cls of value.split(/\s+/)) {
        if (PHYSICAL.test(cls)) {
          context.report({ node, messageId: 'physical', data: { cls } });
          return;
        }
      }
    };
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    };
  },
};

export default rule;
