import { DEFAULT_THEME, themeTokens } from "../src/theme";
for (const [name, value] of Object.entries(themeTokens(DEFAULT_THEME))) {
  console.log(`  ${name}: ${value};`);
}
