const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DEFAULT_OUTPUT_ROOT = path.join(__dirname, '..', 'data', 'documents');
let configuredOutputRoot = DEFAULT_OUTPUT_ROOT;
const WORD_TIMEOUT_MS = 30000;
const MAX_PUBLISH_ATTEMPTS = 100;

const LIMITS = Object.freeze({
  title: 200,
  sections: 50,
  itemsPerSection: 100,
  text: 10000,
  totalText: 100000
});

// This command is deliberately constant. All document content and paths travel
// through the JSON job file named by $env:SPIDER_DOCUMENT_JOB, never through
// command text.
const POWERSHELL_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $env:SPIDER_DOCUMENT_JOB -Raw -Encoding UTF8 | ConvertFrom-Json
$word = $null
$document = $null
$selection = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $document = $word.Documents.Add()
  $selection = $word.Selection

  $selection.Font.Bold = 1
  $selection.Font.Size = 18
  $selection.TypeText([string]$job.title)
  $selection.TypeParagraph()
  $selection.Font.Bold = 0
  $selection.Font.Size = 11

  foreach ($section in $job.sections) {
    $selection.Font.Bold = 1
    $selection.Font.Size = 14
    $selection.TypeText([string]$section.heading)
    $selection.TypeParagraph()
    $selection.Font.Bold = 0
    $selection.Font.Size = 11

    foreach ($paragraph in $section.paragraphs) {
      $selection.TypeText([string]$paragraph)
      $selection.TypeParagraph()
    }
    foreach ($bullet in $section.bullets) {
      $selection.TypeText([string]([char]0x2022 + ' ' + $bullet))
      $selection.TypeParagraph()
    }
    $selection.TypeParagraph()
  }

  $document.SaveAs2([string]$job.outputPath, 12)
}
finally {
  if ($null -ne $document) {
    try { $document.Close(0) } catch { }
  }
  if ($null -ne $word) {
    try { $word.Quit(0) } catch { }
  }
  if ($null -ne $selection) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($selection) } catch { }
  }
  if ($null -ne $document) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) } catch { }
  }
  if ($null -ne $word) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch { }
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`;

function defaultRunner(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function checkedText(value, label, maximum, allowEmpty = false) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (!allowEmpty && value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
  if (value.length > maximum) throw new RangeError(`${label} exceeds ${maximum} characters`);
  return value;
}

function checkedItems(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.itemsPerSection) {
    throw new RangeError(`${label} must be an array with at most ${LIMITS.itemsPerSection} items`);
  }
  return value.map((item, index) => checkedText(item, `${label}[${index}]`, LIMITS.text));
}

function validateInput(input) {
  if (!isPlainObject(input)) throw new TypeError('Document input must be an object');
  assertOnlyKeys(input, ['title', 'sections', 'format'], 'Document input');

  const title = checkedText(input.title, 'title', LIMITS.title);
  if (!Array.isArray(input.sections) || input.sections.length === 0 || input.sections.length > LIMITS.sections) {
    throw new RangeError(`sections must contain between 1 and ${LIMITS.sections} sections`);
  }

  const sections = input.sections.map((section, sectionIndex) => {
    if (!isPlainObject(section)) throw new TypeError(`sections[${sectionIndex}] must be an object`);
    assertOnlyKeys(section, ['heading', 'paragraphs', 'bullets'], `sections[${sectionIndex}]`);
    return {
      heading: checkedText(section.heading, `sections[${sectionIndex}].heading`, LIMITS.title),
      paragraphs: checkedItems(section.paragraphs, `sections[${sectionIndex}].paragraphs`),
      bullets: checkedItems(section.bullets, `sections[${sectionIndex}].bullets`)
    };
  });

  const format = input.format === undefined ? 'docx' : input.format;
  if (format !== 'docx' && format !== 'markdown') {
    throw new TypeError('format must be either docx or markdown');
  }

  const totalText = title.length + sections.reduce((total, section) => {
    return total + section.heading.length +
      section.paragraphs.reduce((sum, text) => sum + text.length, 0) +
      section.bullets.reduce((sum, text) => sum + text.length, 0);
  }, 0);
  if (totalText > LIMITS.totalText) throw new RangeError('Document content is too large');

  return { title, sections, format };
}

function sanitizeFilename(title) {
  let name = title.normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '');

  name = Array.from(name).slice(0, 80).join('').replace(/[. ]+$/g, '');
  if (!name) name = 'document';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `document_${name}`;
  return name;
}

function timestampFrom(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must produce a valid date or timestamp');
  return date.toISOString().replace(/[-:.]/g, '');
}

function identifierFrom(id) {
  const value = typeof id === 'function' ? id() : id;
  const identifier = String(value).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (!identifier) throw new TypeError('id must produce a non-empty identifier');
  return identifier;
}

function candidatePath(outputRoot, stem, extension, attempt) {
  const suffix = attempt === 0 ? '' : `-${attempt}`;
  return path.join(outputRoot, `${stem}${suffix}.${extension}`);
}

function renderMarkdown(document) {
  const lines = [`# ${document.title}`, ''];
  for (const section of document.sections) {
    lines.push(`## ${section.heading}`, '');
    for (const paragraph of section.paragraphs) lines.push(paragraph, '');
    for (const bullet of section.bullets) lines.push(`- ${bullet}`);
    if (section.bullets.length > 0) lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function publishMarkdown(outputRoot, stem, markdown) {
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const destination = candidatePath(outputRoot, stem, 'md', attempt);
    try {
      fs.writeFileSync(destination, markdown, { encoding: 'utf8', flag: 'wx' });
      return destination;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique Markdown filename');
}

function publishDocx(outputRoot, stem, temporaryDocx) {
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const destination = candidatePath(outputRoot, stem, 'docx', attempt);
    try {
      fs.copyFileSync(temporaryDocx, destination, fs.constants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique DOCX filename');
}

function validateGeneratedDocx(filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Word did not create a DOCX file');
    throw error;
  }
  if (!stats.isFile() || stats.size === 0) throw new Error('Word did not create a valid DOCX file');
}

async function createDocument(input, deps = {}) {
  const document = validateInput(input);
  const outputRoot = path.resolve(deps.outputRoot || configuredOutputRoot);
  const platform = deps.platform === undefined ? process.platform : deps.platform;
  const clock = deps.clock === undefined ? Date.now : deps.clock;
  const id = deps.id === undefined ? crypto.randomUUID : deps.id;
  const runner = deps.runner || defaultRunner;

  fs.mkdirSync(outputRoot, { recursive: true });
  const stem = `${sanitizeFilename(document.title)}-${timestampFrom(clock)}-${identifierFrom(id)}`;
  const markdown = () => renderMarkdown(document);

  if (document.format === 'markdown') {
    return {
      ok: true,
      path: publishMarkdown(outputRoot, stem, markdown()),
      format: 'markdown',
      warning: null
    };
  }

  if (platform !== 'win32') {
    return {
      ok: true,
      path: publishMarkdown(outputRoot, stem, markdown()),
      format: 'markdown',
      warning: 'DOCX requires Microsoft Word on Windows; saved Markdown instead.'
    };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-document-'));
  const jobPath = path.join(temporaryDirectory, 'job.json');
  const temporaryDocx = path.join(temporaryDirectory, 'output.docx');

  try {
    const job = {
      title: document.title,
      sections: document.sections,
      outputPath: temporaryDocx
    };
    fs.writeFileSync(jobPath, JSON.stringify(job), { encoding: 'utf8', flag: 'wx' });

    try {
      await runner('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        POWERSHELL_COMMAND
      ], {
        shell: false,
        timeout: WORD_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, SPIDER_DOCUMENT_JOB: jobPath }
      });
      validateGeneratedDocx(temporaryDocx);
      const destination = publishDocx(outputRoot, stem, temporaryDocx);
      return { ok: true, path: destination, format: 'docx', warning: null };
    } catch (error) {
      return {
        ok: true,
        path: publishMarkdown(outputRoot, stem, markdown()),
        format: 'markdown',
        warning: `DOCX creation failed; saved Markdown instead (${error.message || 'unknown error'}).`
      };
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function setOutputRoot(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Document directory must be absolute');
  configuredOutputRoot = path.resolve(directory);
  return configuredOutputRoot;
}
function getOutputRoot() {
  return configuredOutputRoot;
}

module.exports = { createDocument, setOutputRoot, getOutputRoot };
