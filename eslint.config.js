import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "eslint.config.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
);
