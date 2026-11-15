import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('ambiente de teste funciona', () => {
    expect(1 + 1).toBe(2);
  });

  it('jsdom fornece document', () => {
    document.body.innerHTML = '<main id="main"></main>';
    expect(document.getElementById('main')).not.toBeNull();
  });
});
