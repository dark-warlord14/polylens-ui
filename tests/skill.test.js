const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// 1. SKILL.md is served from src/ so it's reachable at /SKILL.md on the live app.
{
  const skill = path.join(SRC, 'SKILL.md');
  assert.ok(fs.existsSync(skill), 'src/SKILL.md must exist to be served at /SKILL.md');
  const text = fs.readFileSync(skill, 'utf8').trim();
  assert.ok(text.length > 0, 'src/SKILL.md must not be empty');
  assert.ok(/^---\nname:/.test(text), 'src/SKILL.md must start with skill frontmatter (name)');
  console.log('skill.test: src/SKILL.md present + frontmatter OK');
}

// 2. The dashboard links to /SKILL.md so users/agents can reach it.
{
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  assert.ok(
    /href="\/SKILL\.md"/.test(html),
    'index.html must link to /SKILL.md so the file is discoverable from the UI',
  );
  console.log('skill.test: index.html links to /SKILL.md OK');
}
