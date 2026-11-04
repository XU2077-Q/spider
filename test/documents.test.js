const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDocument } = require('../agent/documents');

const FIXED_CLOCK = () => new Date('2024-01-02T03:04:05.006Z');
const FIXED_ID = () => 'fixed-id';

function fixture(t) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spider-documents-test-'));
  t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
  return {
    outputRoot,
    clock: FIXED_CLOCK,
    id: FIXED_ID
  };
}

function content(title = 'Quarterly report') {
  return {
    title,
    sections: [
      {
        heading: 'Summary',
        paragraphs: ['A bounded paragraph.'],
        bullets: ['First point', 'Second point']
      }
    ]
  };
}

function successfulWordRunner(captured) {
  return async (executable, args, options) => {
    captured.executable = executable;
    captured.args = args;
    captured.options = options;
    const commandIndex = args.indexOf('-Command');
    captured.command = args[commandIndex + 1];
    captured.jobPath = options.env.SPIDER_DOCUMENT_JOB;
    assert.ok(captured.jobPath, 'the temporary job path travels through the environment');
    captured.job = JSON.parse(fs.readFileSync(captured.jobPath, 'utf8'));
    fs.writeFileSync(captured.job.outputPath, 'fake DOCX bytes', { flag: 'wx' });
  };
}

test('Markdown sanitizes traversal titles and preserves structured content', async (t) => {
  const deps = fixture(t);
  const input = content('../../evil:report?');
  input.format = 'markdown';

  const result = await createDocument(input, {
    ...deps,
    platform: 'win32',
    runner: async () => assert.fail('Markdown must not invoke Word')
  });

  assert.equal(result.ok, true);
  assert.equal(result.format, 'markdown');
  assert.equal(result.warning, null);
  assert.equal(path.dirname(result.path), deps.outputRoot);
  assert.equal(path.extname(result.path), '.md');
  assert.ok(!path.basename(result.path).includes('/'));
  assert.ok(!path.basename(result.path).includes('\\'));
  assert.ok(fs.existsSync(result.path));

  const markdown = fs.readFileSync(result.path, 'utf8');
  assert.match(markdown, /# \.\.\/\.\.\/evil:report\?/);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /A bounded paragraph\./);
  assert.match(markdown, /- First point\n- Second point/);
});

test('Markdown retries collisions and never overwrites an existing sentinel', async (t) => {
  const deps = fixture(t);
  const input = { ...content('Collision'), format: 'markdown' };
  const options = { ...deps, platform: 'linux' };

  const first = await createDocument(input, options);
  fs.writeFileSync(first.path, 'SENTINEL', 'utf8');
  const second = await createDocument(input, options);

  assert.notEqual(second.path, first.path);
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'SENTINEL');
  assert.match(fs.readFileSync(second.path, 'utf8'), /A bounded paragraph\./);
});

test('DOCX requests fall back honestly on non-Windows without invoking a runner', async (t) => {
  const deps = fixture(t);
  const result = await createDocument(content('Unsupported platform'), {
    ...deps,
    platform: 'darwin',
    runner: async () => assert.fail('Non-Windows fallback must not invoke Word')
  });

  assert.equal(result.ok, true);
  assert.equal(result.format, 'markdown');
  assert.equal(path.extname(result.path), '.md');
  assert.match(result.warning, /Windows/);
  assert.ok(fs.existsSync(result.path));
});

test('Word and COM errors fall back to Markdown instead of claiming DOCX', async (t) => {
  const deps = fixture(t);
  const result = await createDocument(content('Missing Word'), {
    ...deps,
    platform: 'win32',
    runner: async () => {
      throw new Error('Word.Application COM class is unavailable');
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.format, 'markdown');
  assert.equal(path.extname(result.path), '.md');
  assert.match(result.warning, /DOCX creation failed/);
  assert.deepEqual(fs.readdirSync(deps.outputRoot).filter((name) => name.endsWith('.docx')), []);
});

test('a successful runner without a generated file also falls back honestly', async (t) => {
  const deps = fixture(t);
  const result = await createDocument(content('No output'), {
    ...deps,
    platform: 'win32',
    runner: async () => ({ stdout: '', stderr: '' })
  });

  assert.equal(result.format, 'markdown');
  assert.match(result.warning, /did not create/);
  assert.equal(fs.existsSync(result.path), true);
});

test('DOCX uses a fixed shell-free command, JSON content transport, and SaveAs2 format 12', async (t) => {
  const deps = fixture(t);
  const captured = {};
  const secretTitle = 'USER-TEXT-title-$()-;';
  const secretParagraph = 'USER-TEXT-paragraph-Invoke-Expression';
  const input = content(secretTitle);
  input.sections[0].paragraphs[0] = secretParagraph;

  const result = await createDocument(input, {
    ...deps,
    platform: 'win32',
    runner: successfulWordRunner(captured)
  });

  assert.equal(result.ok, true);
  assert.equal(result.format, 'docx');
  assert.equal(result.warning, null);
  assert.equal(path.extname(result.path), '.docx');
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'fake DOCX bytes');

  assert.equal(captured.executable, 'powershell.exe');
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.timeout, 30000);
  assert.ok(captured.args.includes('-Command'));
  assert.match(captured.command, /\$env:SPIDER_DOCUMENT_JOB/);
  assert.ok(!captured.args.some((arg) => arg.includes('job.json')));
  assert.ok(!captured.args.includes('.ps1'));
  assert.ok(!captured.args.some((arg) => arg.includes('ExecutionPolicy')));
  assert.ok(!captured.command.includes(secretTitle));
  assert.ok(!captured.command.includes(secretParagraph));
  assert.ok(!captured.args.some((arg) => arg.includes(secretTitle) || arg.includes(secretParagraph)));
  assert.match(captured.command, /Documents\.Add\(\)/);
  assert.match(captured.command, /SaveAs2\([^\n]+,\s*12\)/);
  assert.match(captured.command, /finally\s*\{/);
  assert.match(captured.command, /ReleaseComObject/);
  assert.doesNotMatch(captured.command, /Invoke-Expression|iex\s/);

  assert.equal(captured.job.title, secretTitle);
  assert.equal(captured.job.sections[0].paragraphs[0], secretParagraph);
  assert.equal(fs.existsSync(path.dirname(captured.jobPath)), false, 'private temp directory is cleaned up');
});

test('DOCX publication retries collisions without overwriting a sentinel', async (t) => {
  const deps = fixture(t);
  const options = { ...deps, platform: 'win32', runner: successfulWordRunner({}) };
  const input = content('DOCX collision');

  const first = await createDocument(input, options);
  fs.writeFileSync(first.path, 'DOCX SENTINEL', 'utf8');
  const second = await createDocument(input, options);

  assert.notEqual(second.path, first.path);
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'DOCX SENTINEL');
  assert.equal(fs.readFileSync(second.path, 'utf8'), 'fake DOCX bytes');
});

test('input rejects executable or model configuration fields and unbounded content', async (t) => {
  const deps = fixture(t);
  const options = { ...deps, platform: 'linux', format: 'markdown' };

  await assert.rejects(
    createDocument({ ...content(), command: 'calc.exe' }, options),
    /unsupported field/
  );
  await assert.rejects(
    createDocument({ title: 'Bad', sections: [{ heading: 'Bad', modelPath: 'model.bin' }] }, options),
    /unsupported field/
  );
  await assert.rejects(createDocument({ ...content(), format: 'template' }, options), /format/);
  await assert.rejects(
    createDocument({ title: 'x'.repeat(201), sections: content().sections }, options),
    /exceeds/
  );
});
