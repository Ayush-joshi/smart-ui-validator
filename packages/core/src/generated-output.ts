import { isAbsolute, posix } from 'node:path';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import postcss from 'postcss';
import type { Config } from './config.js';
import type { GeneratedHtmlBundle, GeneratedHtmlFile } from './generation-contracts.js';
import { SmartUiError } from './errors.js';

const WINDOWS_DEVICE = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function validateGeneratedBundle(
  bundle: GeneratedHtmlBundle,
  limits: Config['generation']['limits'],
): void {
  if (bundle.files.length === 0 || bundle.files.length > limits.maxGeneratedFiles) {
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      `Generated file count must be from 1 to ${limits.maxGeneratedFiles}.`,
    );
  }
  const paths = new Set<string>();
  const folded = new Set<string>();
  let total = 0;
  for (const file of bundle.files) {
    validateGeneratedPath(file.relativePath);
    const normalized = posix.normalize(file.relativePath);
    if (normalized !== file.relativePath)
      throw new SmartUiError(
        'POLICY_VIOLATION',
        `Generated path is not canonical: ${file.relativePath}`,
      );
    if (paths.has(normalized) || folded.has(normalized.toLowerCase())) {
      throw new SmartUiError('POLICY_VIOLATION', `Generated path collides: ${file.relativePath}`);
    }
    paths.add(normalized);
    folded.add(normalized.toLowerCase());
    if (file.bytes.byteLength > limits.maxGeneratedFileBytes) {
      throw new SmartUiError(
        'PROVIDER_FAILURE',
        `Generated file exceeds byte budget: ${file.relativePath}`,
      );
    }
    if (
      !file.rationale.trim() ||
      file.rationale.length > 4_000 ||
      file.sourceNodeIds.length > 100 ||
      file.sourceNodeIds.some((id) => !id || id.length > 200)
    ) {
      throw new SmartUiError(
        'PROVIDER_FAILURE',
        `Generated file metadata is outside its bounded contract: ${file.relativePath}`,
      );
    }
    total += file.bytes.byteLength;
    if (total > limits.maxTotalOutputBytes) {
      throw new SmartUiError('PROVIDER_FAILURE', 'Generated output exceeds its total byte budget.');
    }
  }
  if (!paths.has('index.html') || !paths.has('styles.css')) {
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      'Generated output requires index.html and styles.css.',
    );
  }
  for (const file of bundle.files) validateGeneratedContent(file, paths);
}

export function validateGeneratedPath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes('%') ||
    path.includes('?') ||
    path.includes('#') ||
    [...path].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    }) ||
    isAbsolute(path) ||
    path.startsWith('/') ||
    path.endsWith('/')
  ) {
    throw new SmartUiError('POLICY_VIOLATION', `Invalid generated path: ${path}`);
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.')) {
      throw new SmartUiError('POLICY_VIOLATION', `Unsafe generated path segment: ${path}`);
    }
    const device = segment.split('.')[0]!.toLowerCase();
    if (WINDOWS_DEVICE.has(device)) {
      throw new SmartUiError('POLICY_VIOLATION', `Reserved generated filename: ${path}`);
    }
  }
  if (path !== 'index.html' && path !== 'styles.css' && !path.startsWith('assets/')) {
    throw new SmartUiError(
      'POLICY_VIOLATION',
      `Generated path is outside the output contract: ${path}`,
    );
  }
}

function validateGeneratedContent(
  file: GeneratedHtmlFile,
  declaredPaths: ReadonlySet<string>,
): void {
  if (
    !['text/html', 'text/css', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'].includes(
      file.mediaType,
    )
  ) {
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      `Unsupported generated media type: ${file.mediaType}`,
    );
  }
  const expectedExtension = {
    'text/html': '.html',
    'text/css': '.css',
    'image/svg+xml': '.svg',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  }[file.mediaType];
  const lowerPath = file.relativePath.toLowerCase();
  const extensionMatches =
    file.mediaType === 'image/jpeg'
      ? lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')
      : expectedExtension !== undefined && lowerPath.endsWith(expectedExtension);
  if (!extensionMatches) {
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      `Generated media type does not match its file extension: ${file.relativePath}`,
    );
  }
  if (
    (file.relativePath === 'index.html' && file.mediaType !== 'text/html') ||
    (file.relativePath === 'styles.css' && file.mediaType !== 'text/css')
  ) {
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      `Generated entrypoint has an invalid media type: ${file.relativePath}`,
    );
  }
  if (!file.mediaType.startsWith('text/') && file.mediaType !== 'image/svg+xml') return;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new SmartUiError('PROVIDER_FAILURE', `Generated text is not UTF-8: ${file.relativePath}`);
  }
  if (file.mediaType === 'text/html') validateHtml(text, file.relativePath, declaredPaths);
  else if (file.mediaType === 'text/css') validateCss(text, file.relativePath, declaredPaths);
  else validateSvgAsset(text, file.relativePath, declaredPaths);
}

const FORBIDDEN_HTML_ELEMENTS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'foreignobject',
  'base',
]);
const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'formaction',
  'href',
  'manifest',
  'poster',
  'src',
  'xlink:href',
]);
const URL_LIST_ATTRIBUTES = new Set(['ping']);
const SOURCE_SET_ATTRIBUTES = new Set(['imagesrcset', 'srcset']);

function validateHtml(
  text: string,
  relativePath: string,
  declaredPaths: ReadonlySet<string>,
): void {
  const parseErrors: string[] = [];
  const document = parse(text, { onParseError: (error) => parseErrors.push(error.code) });
  if (parseErrors.length > 20) {
    throw policy(`Generated HTML exceeds its parse-error budget: ${relativePath}`);
  }
  walkHtml(document, (element) => {
    const tagName = element.tagName.toLowerCase();
    if (FORBIDDEN_HTML_ELEMENTS.has(tagName)) {
      throw policy(`Generated HTML contains forbidden <${tagName}>: ${relativePath}`);
    }
    const attributes = new Map(
      element.attrs.map((attribute) => [attribute.name.toLowerCase(), attribute.value]),
    );
    if ([...attributes.keys()].some((name) => name.startsWith('on'))) {
      throw policy(`Generated HTML contains an event-handler attribute: ${relativePath}`);
    }
    for (const [name, value] of attributes) {
      if (URL_ATTRIBUTES.has(name)) {
        validateLocalReference(value, relativePath, declaredPaths, `${tagName}[${name}]`);
      }
      if (URL_LIST_ATTRIBUTES.has(name)) {
        for (const reference of value.trim().split(/\s+/u)) {
          validateLocalReference(reference, relativePath, declaredPaths, `${tagName}[${name}]`);
        }
      }
      if (SOURCE_SET_ATTRIBUTES.has(name)) {
        validateSourceSet(value, relativePath, declaredPaths, `${tagName}[${name}]`);
      }
      if (name === 'style') validateCss(`x{${value}}`, relativePath, declaredPaths);
    }
    if (tagName === 'meta' && attributes.get('http-equiv')?.toLowerCase() === 'refresh') {
      throw policy(`Generated HTML contains meta refresh: ${relativePath}`);
    }
    if (tagName === 'link') {
      if (attributes.get('rel')?.toLowerCase() !== 'stylesheet') {
        throw policy(`Generated HTML contains a non-stylesheet link: ${relativePath}`);
      }
    }
    if (tagName === 'style') {
      const css = element.childNodes
        .filter((node): node is DefaultTreeAdapterTypes.TextNode => node.nodeName === '#text')
        .map((node) => node.value)
        .join('');
      validateCss(css, relativePath, declaredPaths);
    }
  });
}

function walkHtml(
  node: DefaultTreeAdapterTypes.Node,
  visit: (node: DefaultTreeAdapterTypes.Element) => void,
): void {
  if ('tagName' in node) visit(node);
  if ('childNodes' in node) {
    for (const child of node.childNodes) walkHtml(child, visit);
  }
  if ('content' in node) walkHtml(node.content, visit);
}

function validateCss(text: string, relativePath: string, declaredPaths: ReadonlySet<string>): void {
  // CSS escapes can obscure identifiers such as url(), @import, and executable legacy properties.
  // Generated output does not need them, so this boundary rejects them rather than attempting a
  // second, browser-equivalent tokenization pass.
  if (text.includes('\\')) {
    throw policy(`Generated CSS contains an escaped token: ${relativePath}`);
  }
  let root;
  try {
    root = postcss.parse(text, { from: relativePath });
  } catch (error) {
    throw policy(
      `Generated CSS is invalid in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  root.walkAtRules((rule) => {
    if (['import', 'font-face', 'document'].includes(rule.name.toLowerCase())) {
      throw policy(`Generated CSS contains forbidden @${rule.name}: ${relativePath}`);
    }
    validateCssReferences(rule.params, relativePath, declaredPaths, `CSS @${rule.name}`);
  });
  root.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    const value = declaration.value;
    if (property === 'behavior' || property === '-moz-binding' || /expression\s*\(/i.test(value)) {
      throw policy(`Generated CSS contains executable legacy content: ${relativePath}`);
    }
    validateCssReferences(value, relativePath, declaredPaths, `CSS ${property}`);
  });
}

function validateCssReferences(
  value: string,
  relativePath: string,
  declaredPaths: ReadonlySet<string>,
  label: string,
): void {
  if (/(?:^|[\s('"=:,])(?:https?|javascript|vbscript|file):|\/\//iu.test(value)) {
    throw policy(`Generated output contains an external or unsafe ${label} reference.`);
  }
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)) {
    validateLocalReference(match[2] ?? '', relativePath, declaredPaths, label);
  }
}

function validateSvgAsset(
  text: string,
  relativePath: string,
  declaredPaths: ReadonlySet<string>,
): void {
  if (/<!doctype|<!entity|<\?xml-stylesheet/iu.test(text)) {
    throw policy(
      `Generated SVG asset contains a declaration or processing instruction: ${relativePath}`,
    );
  }
  const lowered = text.toLowerCase();
  for (const forbidden of ['<script', '<foreignobject', 'javascript:', 'vbscript:', '@import']) {
    if (lowered.includes(forbidden)) {
      throw policy(`Generated SVG asset contains forbidden content: ${relativePath}`);
    }
  }
  if (/\son[a-z][a-z0-9_-]*\s*=/iu.test(text)) {
    throw policy(`Generated SVG asset contains an event handler: ${relativePath}`);
  }
  validateHtml(text, relativePath, declaredPaths);
}

function validateSourceSet(
  value: string,
  ownerPath: string,
  declaredPaths: ReadonlySet<string>,
  label: string,
): void {
  for (const candidate of value.split(',')) {
    const reference = candidate.trim().split(/\s+/u, 1)[0] ?? '';
    if (!reference || reference.toLowerCase().startsWith('data:')) {
      throw policy(`Generated output contains an invalid or unsupported ${label} reference.`);
    }
    validateLocalReference(reference, ownerPath, declaredPaths, label);
  }
}

function validateLocalReference(
  value: string,
  ownerPath: string,
  declaredPaths: ReadonlySet<string>,
  label: string,
): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '#' || trimmed.startsWith('#')) return;
  if (/^data:image\/(?:png|jpeg|webp);/iu.test(trimmed)) return;
  if (trimmed.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    throw policy(`Generated output contains an external or unsafe ${label} reference.`);
  }
  const withoutFragment = trimmed.split(/[?#]/u, 1)[0] ?? '';
  const resolved = posix.normalize(posix.join(posix.dirname(ownerPath), withoutFragment));
  if (
    !withoutFragment ||
    resolved.startsWith('../') ||
    resolved.startsWith('/') ||
    !declaredPaths.has(resolved)
  ) {
    throw policy(`Generated output references an undeclared local file from ${label}: ${trimmed}`);
  }
}

function policy(message: string): SmartUiError {
  return new SmartUiError('POLICY_VIOLATION', message);
}
