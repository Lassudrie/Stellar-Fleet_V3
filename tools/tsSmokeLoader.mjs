import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compilerOptions = {
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true
};

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const tsUrl = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, context.parentURL);
      try {
        await readFile(tsUrl);
        return { url: tsUrl.href, shortCircuit: true };
      } catch {
        // Try folder index fallback (e.g., ./scenarios -> ./scenarios/index.ts)
        const indexUrl = new URL(specifier.endsWith('/') ? `${specifier}index.ts` : `${specifier}/index.ts`, context.parentURL);
        try {
          await readFile(indexUrl);
          return { url: indexUrl.href, shortCircuit: true };
        } catch {
          // fall through to throw original error
        }
      }
    }

    throw error;
  }
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith('.ts')) {
    const source = await readFile(new URL(url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions, fileName: url });
    return { format: 'module', source: outputText, shortCircuit: true };
  }

  return defaultLoad(url, context, defaultLoad);
}
