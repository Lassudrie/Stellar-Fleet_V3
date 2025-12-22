const tailwindcss = () => ({
  postcssPlugin: 'tailwindcss',
  AtRule: {
    tailwind(atRule) {
      atRule.remove();
    },
  },
});

tailwindcss.postcss = true;

module.exports = tailwindcss;
