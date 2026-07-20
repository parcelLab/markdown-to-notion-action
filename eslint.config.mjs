import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import prettier from "eslint-plugin-prettier";
import unicorn from "eslint-plugin-unicorn";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "**/*.d.ts"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      prettier,
      unicorn,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...unicorn.configs.recommended.rules,
      ...eslintConfigPrettier.rules,
      "prettier/prettier": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "unicorn/name-replacements": "off",
      "unicorn/no-array-reverse": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-break-in-nested-loop": "off",
      "unicorn/no-null": "off",
    },
  },
];
