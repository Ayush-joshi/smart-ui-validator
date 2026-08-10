import { isAbsolute, posix } from 'node:path';
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
    total += file.bytes.byteLength;
    if (total > limits.maxTotalOutputBytes) {
      throw new SmartUiError('PROVIDER_FAILURE', 'Generated output exceeds its total byte budget.');
    }
    validateGeneratedContent(file);
  }
  if (!paths.has('index.html') || !paths.has('styles.css')) {
    throw new SmartUiError(
      'PROVIDER_FAILURE',
      'Generated output requires index.html and styles.css.',
    );
  }
}

export function validateGeneratedPath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
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

function validateGeneratedContent(file: GeneratedHtmlFile): void {
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
  if (!file.mediaType.startsWith('text/') && file.mediaType !== 'image/svg+xml') return;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new SmartUiError('PROVIDER_FAILURE', `Generated text is not UTF-8: ${file.relativePath}`);
  }
  const lowered = text
    .toLowerCase()
    .replaceAll('xmlns="http://www.w3.org/2000/svg"', '')
    .replaceAll("xmlns='http://www.w3.org/2000/svg'", '');
  for (const forbidden of [
    '<script',
    '<iframe',
    '<object',
    '<embed',
    '<foreignobject',
    'javascript:',
    'vbscript:',
    '@import',
    '@font-face',
    'href="http://',
    "href='http://",
    'href="https://',
    "href='https://",
    'src="http://',
    "src='http://",
    'src="https://',
    "src='https://",
    'url(http://',
    'url(https://',
    'url("http://',
    "url('http://",
    'url("https://',
    "url('https://",
    'src="//',
    "src='//",
    'href="//',
    "href='//",
    'meta http-equiv="refresh"',
  ]) {
    if (lowered.includes(forbidden)) {
      throw new SmartUiError(
        'POLICY_VIOLATION',
        `Generated output contains forbidden content '${forbidden}': ${file.relativePath}`,
      );
    }
  }
}
