import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Key material must stay behind the signer boundary: only signer.ts may
  // import the escape hatch that exposes the private key.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/signer.ts", "src/lib/passkey.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/passkey",
              importNames: ["unsafeWithSessionKey"],
              message:
                "unsafeWithSessionKey exposes the private key. Only src/lib/signer.ts may use it - add a signer.ts function instead.",
            },
          ],
          patterns: [
            {
              group: ["**/passkey"],
              importNamePattern: "^unsafeWithSessionKey$",
              message:
                "unsafeWithSessionKey exposes the private key. Only src/lib/signer.ts may use it - add a signer.ts function instead.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
