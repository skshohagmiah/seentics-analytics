/**
 * Micro template engine: {{path.to.value | filter:arg}} syntax.
 * Supports dot-notation paths and pipe-chained filters.
 */

const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function applyFilter(value: unknown, filter: string): unknown {
  const colonIdx = filter.indexOf(':');
  const name = colonIdx === -1 ? filter.trim() : filter.slice(0, colonIdx).trim();
  const arg  = colonIdx === -1 ? '' : filter.slice(colonIdx + 1).trim();

  switch (name) {
    case 'uppercase':   return String(value ?? '').toUpperCase();
    case 'lowercase':   return String(value ?? '').toLowerCase();
    case 'capitalize':  return String(value ?? '').replace(/\b\w/g, (c) => c.toUpperCase());
    case 'default':     return (value == null || value === '') ? arg : value;
    case 'ordinal': {
      const n = Number(value);
      if (isNaN(n)) return String(value ?? '');
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }
    case 'currency': {
      const n = Number(value);
      if (isNaN(n)) return String(value ?? '');
      const currency = arg || 'USD';
      try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n); }
      catch { return `${currency} ${n.toFixed(2)}`; }
    }
    case 'seconds': {
      const n = Number(value);
      if (isNaN(n)) return String(value ?? '');
      if (n < 60) return `${n}s`;
      const m = Math.floor(n / 60), s2 = n % 60;
      return s2 ? `${m}m ${s2}s` : `${m}m`;
    }
    case 'minutes': {
      const n = Number(value);
      if (isNaN(n)) return String(value ?? '');
      const m = Math.floor(n / 60);
      return `${m}m`;
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(String(value ?? ''));
      if (isNaN(d.getTime())) return String(value ?? '');
      try { return d.toLocaleDateString('en-US', arg ? { dateStyle: arg as Intl.DateTimeFormatOptions['dateStyle'] } : undefined); }
      catch { return d.toLocaleDateString(); }
    }
    default: return value;
  }
}

function resolveToken(token: string, context: Record<string, unknown>): string {
  const parts = token.split('|');
  const path  = (parts[0] ?? '').trim();
  let value: unknown = getNestedValue(context, path);
  for (let i = 1; i < parts.length; i++) {
    value = applyFilter(value, parts[i] ?? '');
  }
  return value == null ? '' : String(value);
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(TEMPLATE_RE, (_, token: string) => resolveToken(token, context));
}

export function renderTemplateDeep(obj: unknown, context: Record<string, unknown>): unknown {
  if (typeof obj === 'string') return renderTemplate(obj, context);
  if (Array.isArray(obj)) return obj.map((item) => renderTemplateDeep(item, context));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = renderTemplateDeep(v, context);
    }
    return out;
  }
  return obj;
}
