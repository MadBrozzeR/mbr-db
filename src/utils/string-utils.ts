const KEY_RE = /\$\{([-\w]+)\}/g;

export function template (text: string, substitutions: Record<string, string | number>) {
  return text.replace(KEY_RE, function (source, key) {
    return (substitutions[key] !== undefined) ? substitutions[key].toString() : source;
  });
}
