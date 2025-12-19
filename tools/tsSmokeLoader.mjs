import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compilerOptions = {
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true
};

const tryResolveWithExtensions = async (baseSpecifier, parentURL, extensions) => {
  for (const ext of extensions) {
    const candidate = baseSpecifier.endsWith(ext) ? baseSpecifier : `${baseSpecifier}${ext}`;
    const candidateUrl = new URL(candidate, parentURL);
    try {
      await readFile(candidateUrl);
      return { url: candidateUrl.href, shortCircuit: true };
    } catch {
      // continue
    }
  }

  for (const ext of extensions) {
    const candidate = baseSpecifier.endsWith('/') ? `${baseSpecifier}index${ext}` : `${baseSpecifier}/index${ext}`;
    const candidateUrl = new URL(candidate, parentURL);
    try {
      await readFile(candidateUrl);
      return { url: candidateUrl.href, shortCircuit: true };
    } catch {
      // continue
    }
  }

  return null;
};

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = await tryResolveWithExtensions(specifier, context.parentURL, ['.ts', '.tsx']);
      if (resolved) return resolved;
    }

    throw error;
  }
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = await readFile(new URL(url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions, fileName: url });
    return { format: 'module', source: outputText, shortCircuit: true };
  }

  return defaultLoad(url, context, defaultLoad);
}
