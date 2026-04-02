import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: ['**/dist/**', '**/node_modules/**', '**/*.js'],
    },
    {
        rules: {
            // 允许未使用的变量以 _ 开头
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            // 允许 any 类型（逐步收紧）
            '@typescript-eslint/no-explicit-any': 'warn',
            // 允许空函数（占位符阶段）
            '@typescript-eslint/no-empty-function': 'off',
        },
    },
);
