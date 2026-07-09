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
    // Generated/native iOS artifacts (cap sync copies the web build into
    // ios/App/App/public, SPM builds under ios/App/CapApp-SPM/.build)
    "ios/**",
    // Node build utilities, CommonJS by design
    "scripts/**",
  ]),
  // Key material must stay behind the signer boundary: only signer.ts may
  // import the escape hatches that expose the private key or the Kohaku
  // privacy root (setKohakuSession is the sink the root flows into).
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
              importNames: ["unsafeWithSessionKey", "unsafeWithSessionSecrets"],
              message:
                "unsafeWithSessionKey/unsafeWithSessionSecrets expose key material. Only src/lib/signer.ts may use them - add a signer.ts function instead.",
            },
            {
              name: "@/lib/kohakuSession",
              importNames: ["setKohakuSession"],
              message:
                "setKohakuSession installs the privacy root secret. Only src/lib/signer.ts may call it.",
            },
          ],
          patterns: [
            {
              group: ["**/passkey"],
              importNamePattern: "^unsafeWithSession(Key|Secrets)$",
              message:
                "unsafeWithSessionKey/unsafeWithSessionSecrets expose key material. Only src/lib/signer.ts may use them - add a signer.ts function instead.",
            },
            {
              group: ["**/kohakuSession"],
              importNamePattern: "^setKohakuSession$",
              message:
                "setKohakuSession installs the privacy root secret. Only src/lib/signer.ts may call it.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
