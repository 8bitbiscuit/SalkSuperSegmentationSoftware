// Just enough XML for AWS's Query and S3 responses: elements and text, no
// attributes, no namespaces. Workers have no DOMParser.

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) =>
  e[0] !== '#' ? ENTITIES[e] ?? whole
    : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', children: [], text: '' };
  const stack = [root];
  for (const [, close, name, selfClosing, text] of
    xml.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>|<[?!][^>]*>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (text !== undefined) top.text += decode(text);
    else if (!name) continue;                       // <?xml ...?>, comments
    else if (close) { if (stack.length > 1) stack.pop(); }
    else {
      const node: XmlNode = { name, children: [], text: '' };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root;
}

/** Follow a path of element names; the first match at each step. */
export function at(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  for (const name of path) node = node?.children.find((c) => c.name === name);
  return node;
}

export const all = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node ? node.children.filter((c) => c.name === name) : [];

export const text = (node: XmlNode | undefined, ...path: string[]): string =>
  (at(node, ...path)?.text ?? '').trim();
