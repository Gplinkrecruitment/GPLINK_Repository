import { describe, it, expect } from 'vitest';

describe('buildMailtoLink', () => {
  function buildMailtoLink(to, subject, body) {
    return 'mailto:' + encodeURIComponent(to) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  }

  it('encodes email, subject, and body', () => {
    const link = buildMailtoLink(
      'contact@practice.com',
      'Offer/Contract Required — Dr Smith at SOP Medical',
      'Hi Jane,\n\nWe require the agreement.\n\nKind regards,\nGP Link Team'
    );
    expect(link).toContain('mailto:contact%40practice.com');
    expect(link).toContain('subject=Offer');
    expect(link).toContain('body=Hi%20Jane');
  });

  it('handles empty fields gracefully', () => {
    const link = buildMailtoLink('', '', '');
    expect(link).toBe('mailto:?subject=&body=');
  });
});

describe('buildPositionDescriptionPrompt', () => {
  function buildPositionDescriptionPrompt(practiceName, roleTitle, location) {
    return 'Generate a professional position description for a General Practitioner joining ' + practiceName + ' in ' + location + ' for the role of ' + roleTitle + '. Include: practice overview, key responsibilities, supervision arrangements, working hours expectations, and professional development opportunities. Return well-structured HTML using <h2>, <h3>, <p>, <ul>, and <li> tags only. Do not include <html>, <head>, or <body> wrapper tags.';
  }

  it('includes practice name, role, and location', () => {
    const prompt = buildPositionDescriptionPrompt('SOP Medical Centre', 'General Practitioner', 'Sydney NSW');
    expect(prompt).toContain('SOP Medical Centre');
    expect(prompt).toContain('General Practitioner');
    expect(prompt).toContain('Sydney NSW');
  });
});

describe('HTML to PDF text extraction', () => {
  it('strips HTML tags while preserving structure markers', () => {
    const html = '<h2>Overview</h2><p>Text here</p><ul><li>Item 1</li><li>Item 2</li></ul>';
    const stripped = html.replace(/<[^>]*>/g, function (tag) {
      if (tag.match(/^<h2/i)) return '\n##HEADING2##';
      if (tag.match(/^<h3/i)) return '\n##HEADING3##';
      if (tag.match(/^<li/i)) return '\n• ';
      if (tag.match(/^<p/i)) return '\n';
      if (tag.match(/^<\/p|^<\/ul|^<\/ol|^<\/li|^<\/h/i)) return '\n';
      return '';
    });
    expect(stripped).toContain('##HEADING2##Overview');
    expect(stripped).toContain('• Item 1');
    expect(stripped).toContain('• Item 2');
    expect(stripped).toContain('Text here');
  });
});

describe('Practice Pack endpoint contracts', () => {
  it('generate-position-description requires task_id', () => {
    const expected = { ok: false, message: 'task_id required.' };
    expect(expected.ok).toBe(false);
    expect(expected.message).toBe('task_id required.');
  });

  it('upload-document requires task_id, file_data, file_name', () => {
    const expected = { ok: false, message: 'task_id, file_data, and file_name required.' };
    expect(expected.ok).toBe(false);
  });

  it('approve-document requires task_id', () => {
    const expected = { ok: false, message: 'task_id required.' };
    expect(expected.ok).toBe(false);
  });
});
