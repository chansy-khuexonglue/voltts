import { HttpMethod, RouteConflictError, RouteMatch, FastParamRoute } from './types';

export class TrieNode<T> {
  segment: string;
  isParam = false;
  paramName: string | null = null;
  isWildcard = false;
  wildcardName = 'wildcard';
  staticChildren = new Map<string, TrieNode<T>>();
  paramChild: TrieNode<T> | null = null;
  wildcardChild: TrieNode<T> | null = null;
  handlers = new Map<string, { handler: T; pattern: string }>();

  constructor(segment = '') {
    this.segment = segment;
  }
}

const EMPTY_PARAMS: Record<string, string> = Object.freeze({});

function splitSegments(path: string): string[] {
  const segments: string[] = [];
  let start = 0;
  const len = path.length;
  while (start < len && path.charCodeAt(start) === 47) start++;
  while (start < len) {
    let end = path.indexOf('/', start);
    if (end === -1) end = len;
    if (end > start) {
      segments.push(path.slice(start, end));
    }
    start = end + 1;
  }
  return segments;
}

// Decode percent-encoded route parameters without changing the path used for matching.
// Malformed percent escapes remain unchanged rather than crashing the router.
function decodeRouteParam(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class TrieRouter<T = unknown> {
  private root = new TrieNode<T>();
  private staticRoutes = new Map<string, { handler: T; pattern: string; method: string }>();
  private staticGetRoutes = new Map<string, RouteMatch<T>>();
  private staticPostRoutes = new Map<string, RouteMatch<T>>();
  private fastGetParamRoutes: FastParamRoute<T>[] = [];
  private allRoutes: Array<{ method: string; path: string; handler: T; pattern: string }> = [];

  constructor(private options: { strictTrailingSlash?: boolean; caseSensitive?: boolean } = {}) {}

  private normalizePath(path: string): string {
    if (!path.startsWith('/')) {
      path = '/' + path;
    }
    if (!this.options.strictTrailingSlash && path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    if (!this.options.caseSensitive) {
      // Keep case as is for segments, but match case-insensitively if needed
    }
    return path;
  }

  add(method: HttpMethod | string, path: string, handler: T): void {
    const normalized = this.normalizePath(path);
    const m = method.toUpperCase();
    const pattern = normalized;

    this.allRoutes.push({ method: m, path: normalized, handler, pattern });

    // Check if route is pure static (no : or *)
    const isDynamic = normalized.includes(':') || normalized.includes('*');
    if (!isDynamic) {
      const staticKey = `${m}:${normalized}`;
      const existing = this.staticRoutes.get(staticKey);
      if (existing) {
        throw new RouteConflictError(existing.pattern, normalized, m);
      }
      this.staticRoutes.set(staticKey, { handler, pattern, method: m });

      const prebuiltMatch: RouteMatch<T> = {
        handler,
        params: EMPTY_PARAMS,
        pattern,
        method: m,
      };

      if (m === 'GET') {
        this.staticGetRoutes.set(normalized, prebuiltMatch);
      } else if (m === 'POST') {
        this.staticPostRoutes.set(normalized, prebuiltMatch);
      }
    } else {
      // Fast single suffix-param detection (e.g. /users/:id or /api/items/:slug)
      const colonIdx = normalized.indexOf(':');
      if (
        colonIdx > 0 &&
        !normalized.includes('*') &&
        normalized.indexOf(':', colonIdx + 1) === -1 &&
        normalized.indexOf('/', colonIdx) === -1
      ) {
        const prefix = normalized.slice(0, colonIdx);
        const paramName = normalized.slice(colonIdx + 1);
        const createParams = (val: string): Record<string, string> => ({ [paramName]: decodeRouteParam(val) });
        if (m === 'GET' || m === 'ALL') {
          this.fastGetParamRoutes.push({
            prefix,
            prefixLen: prefix.length,
            paramName,
            createParams,
            handler,
            pattern,
            method: m,
          });
        }
      }
    }

    // Always insert into Trie for uniform tree lookup and dynamic matching
    const segments = normalized.split('/').filter(Boolean);
    let current = this.root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;

      if (seg.startsWith('*')) {
        const wildcardName = seg.length > 1 ? seg.slice(1) : 'wildcard';
        if (!current.wildcardChild) {
          const node = new TrieNode<T>(seg);
          node.isWildcard = true;
          node.wildcardName = wildcardName;
          current.wildcardChild = node;
        } else if (current.wildcardChild.wildcardName !== wildcardName) {
          // Warning or conflict if name differs
        }
        current = current.wildcardChild;
        break; // Wildcard absorbs remaining segments
      } else if (seg.startsWith(':')) {
        const paramName = seg.slice(1);
        if (!current.paramChild) {
          const node = new TrieNode<T>(seg);
          node.isParam = true;
          node.paramName = paramName;
          current.paramChild = node;
        } else if (current.paramChild.paramName !== paramName) {
          throw new RouteConflictError(
            `:${current.paramChild.paramName}`,
            `:${paramName}`,
            m
          );
        }
        current = current.paramChild;
      } else {
        let child = current.staticChildren.get(seg);
        if (!child) {
          child = new TrieNode<T>(seg);
          current.staticChildren.set(seg, child);
        }
        current = child;
      }
    }

    const existingHandler = current.handlers.get(m);
    if (existingHandler && !isDynamic) {
      // Handled above in static check
    } else if (existingHandler && isDynamic) {
      throw new RouteConflictError(existingHandler.pattern, normalized, m);
    }
    current.handlers.set(m, { handler, pattern });
  }

  match(method: HttpMethod | string, path: string): RouteMatch<T> | null {
    const normalized = this.normalizePath(path);

    // 1. Ultra-fast direct static route lookup without string concatenation
    if (method === 'GET') {
      const match = this.staticGetRoutes.get(normalized);
      if (match) return match;
    } else if (method === 'POST') {
      const match = this.staticPostRoutes.get(normalized);
      if (match) return match;
    }

    const m = method.toUpperCase();
    const staticKey = `${m}:${normalized}`;
    const staticMatch = this.staticRoutes.get(staticKey);
    if (staticMatch) {
      return {
        handler: staticMatch.handler,
        params: EMPTY_PARAMS,
        pattern: staticMatch.pattern,
        method: m,
      };
    }

    // Check HEAD fallback to GET for static routes
    if (m === 'HEAD') {
      const getStatic = this.staticRoutes.get(`GET:${normalized}`);
      if (getStatic) {
        return {
          handler: getStatic.handler,
          params: EMPTY_PARAMS,
          pattern: getStatic.pattern,
          method: 'GET',
        };
      }
    }

    // 2. Ultra-fast single-parameter GET route match (avoids trie search and segment splitting)
    if (m === 'GET') {
      const fastRoutes = this.fastGetParamRoutes;
      const count = fastRoutes.length;
      for (let i = 0; i < count; i++) {
        const r = fastRoutes[i]!;
        if (normalized.length > r.prefixLen && normalized.startsWith(r.prefix) && normalized.indexOf('/', r.prefixLen) === -1) {
          return {
            handler: r.handler,
            params: { [r.paramName]: decodeRouteParam(normalized.slice(r.prefixLen)) },
            pattern: r.pattern,
            method: 'GET',
          };
        }
      }
    }

    // 3. Dynamic Trie Search using fast segment extraction and non-closure traversal
    const segments = splitSegments(normalized);
    const params: Record<string, string> = {};

    const result = this.matchDynamic(this.root, segments, 0, m, params);
    if (result) {
      const h = result.node.handlers.get(m) ?? result.node.handlers.get('ALL') ?? (m === 'HEAD' ? result.node.handlers.get('GET') : undefined);
      if (h) {
        return {
          handler: h.handler,
          params,
          pattern: h.pattern,
          method: m,
        };
      }
    }

    // 3. Fallback for OPTIONS (discover allowed methods)
    if (m === 'OPTIONS') {
      const allowed = this.getAllowedMethods(normalized);
      if (allowed.length > 0) {
        return {
          handler: null as unknown as T,
          params,
          pattern: normalized,
          method: 'OPTIONS',
        };
      }
    }

    return null;
  }

  private matchDynamic(
    node: TrieNode<T>,
    segments: string[],
    index: number,
    m: string,
    params: Record<string, string>
  ): { node: TrieNode<T>; pattern: string } | null {
    if (index === segments.length) {
      if (node.handlers.has(m) || node.handlers.has('ALL')) {
        const h = node.handlers.get(m) ?? node.handlers.get('ALL');
        return { node, pattern: h!.pattern };
      }
      if (m === 'HEAD' && node.handlers.has('GET')) {
        const h = node.handlers.get('GET');
        return { node, pattern: h!.pattern };
      }
      return null;
    }

    const seg = segments[index]!;

    // 1. Static child match
    const staticChild = node.staticChildren.get(seg);
    if (staticChild) {
      const res = this.matchDynamic(staticChild, segments, index + 1, m, params);
      if (res) return res;
    }

    // 2. Param child match
    if (node.paramChild) {
      params[node.paramChild.paramName!] = decodeRouteParam(seg);
      const res = this.matchDynamic(node.paramChild, segments, index + 1, m, params);
      if (res) return res;
      delete params[node.paramChild.paramName!];
    }

    // 3. Wildcard child match
    if (node.wildcardChild) {
      const rest = segments.slice(index).join('/');
      params[node.wildcardChild.wildcardName] = decodeRouteParam(rest);
      if (node.wildcardChild.handlers.has(m) || node.wildcardChild.handlers.has('ALL')) {
        const h = node.wildcardChild.handlers.get(m) ?? node.wildcardChild.handlers.get('ALL');
        return { node: node.wildcardChild, pattern: h!.pattern };
      }
      if (m === 'HEAD' && node.wildcardChild.handlers.has('GET')) {
        const h = node.wildcardChild.handlers.get('GET');
        return { node: node.wildcardChild, pattern: h!.pattern };
      }
      delete params[node.wildcardChild.wildcardName];
    }

    return null;
  }

  getAllowedMethods(path: string): string[] {
    const normalized = this.normalizePath(path);
    const methods = new Set<string>();

    for (const r of this.allRoutes) {
      if (r.path === normalized) {
        methods.add(r.method);
      }
    }

    if (methods.size > 0 && methods.has('GET')) {
      methods.add('HEAD');
    }
    if (methods.size > 0) {
      methods.add('OPTIONS');
    }

    return Array.from(methods);
  }

  getRoutes(): Array<{ method: string; path: string; handler: T; pattern: string }> {
    return [...this.allRoutes];
  }

  getStaticGetMap(): Map<string, RouteMatch<T>> {
    return this.staticGetRoutes;
  }

  getStaticPostMap(): Map<string, RouteMatch<T>> {
    return this.staticPostRoutes;
  }

  getFastGetParamRoutes(): FastParamRoute<T>[] {
    return this.fastGetParamRoutes;
  }
}
