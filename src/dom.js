class EventTargetShim {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    if (typeof handler !== 'function') return;
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(type, handlers.filter(item => item !== handler));
  }

  removeAllListeners(type) {
    if (type === undefined) { this.listeners = new Map(); return; }
    this.listeners.delete(type);
  }

  listenerCount(type) {
    if (type === undefined) return this.listeners.size;
    return (this.listeners.get(type) || []).length;
  }

  dispatchEvent(event) {
    if (!event || typeof event.type !== 'string') {
      throw new TypeError('event.type must be a string');
    }
    // 事件对象可能是原生 Event（target 只读 getter），此时不覆盖已有 target；
    // 未设 target 时才赋当前元素。
    if (!event.target) {
      try { event.target = this; } catch { /* 只读 target，忽略 */ }
    }
    event.currentTarget = this;
    if (!event.preventDefault) {
      event.defaultPrevented = false;
      event.preventDefault = () => { event.defaultPrevented = true; };
    }
    for (const handler of this.listeners.get(event.type) || []) {
      handler.call(this, event);
    }
    const direct = this[`on${event.type}`];
    if (typeof direct === 'function') direct.call(this, event);
    return !event.defaultPrevented;
  }

  attachEvent(name, handler) {
    this.addEventListener(name.replace(/^on/, ''), handler);
  }

  detachEvent(name, handler) {
    this.removeEventListener(name.replace(/^on/, ''), handler);
  }
}

function matchesSelector(element, selector) {
  if (!element || element.nodeType !== 1 || typeof selector !== 'string') {
    return false;
  }
  if (selector.startsWith('#')) {
    return element.getAttribute('id') === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    const classes = (element.getAttribute('class') || '').split(/\s+/);
    return classes.includes(selector.slice(1));
  }
  return element.localName === selector.toLowerCase();
}

function descendantsOf(element) {
  const descendants = [];
  for (const child of element.children) {
    descendants.push(child, ...descendantsOf(child));
  }
  return descendants;
}

class ElementShim extends EventTargetShim {
  constructor(tagName) {
    super();
    const localName = String(tagName).toLowerCase();
    this.tagName = localName.toUpperCase();
    this.nodeName = this.tagName;
    this.localName = localName;
    this.nodeType = 1;
    this.style = {};
    this.attributes = Object.create(null);
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.scrollWidth = 0;
    this.scrollHeight = 0;
    this.scrollLeft = 0;
    this.scrollTop = 0;
  }

  appendChild(child) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name, value) {
    this.attributes[String(name)] = String(value);
  }

  getAttribute(name) {
    const key = String(name);
    return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null;
  }

  getElementsByTagName(tagName) {
    const normalized = String(tagName).toLowerCase();
    return descendantsOf(this).filter(element =>
      normalized === '*' || element.localName === normalized
    );
  }

  querySelector(selector) {
    return descendantsOf(this).find(element => matchesSelector(element, selector)) || null;
  }

  getBoundingClientRect() {
    const width = this.offsetWidth || this.clientWidth || this.width || 0;
    const height = this.offsetHeight || this.clientHeight || this.height || 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      right: width,
      bottom: height,
      left: 0,
      width,
      height,
      toJSON() {
        return {
          x: this.x,
          y: this.y,
          top: this.top,
          right: this.right,
          bottom: this.bottom,
          left: this.left,
          width: this.width,
          height: this.height
        };
      }
    };
  }
}

class DocumentShim extends EventTargetShim {
  constructor({ canvasFactory }) {
    super();
    this.canvasFactory = canvasFactory;
    this.nodeType = 9;
    this.nodeName = '#document';
    this.characterSet = 'UTF-8';
    this.charset = 'UTF-8';
    this.readyState = 'complete';
    this.referrer = '';
    this.cookie = '';
    this.title = '';
    this.defaultView = null;
    this.implementation = { hasFeature: () => false };
    this.documentElement = new ElementShim('html');
    this.head = new ElementShim('head');
    this.body = new ElementShim('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.children = [this.documentElement];
    this.childNodes = this.children;
  }

  createElement(tagName) {
    const normalized = String(tagName).toLowerCase();
    const element = normalized === 'canvas' && this.canvasFactory
      ? this.canvasFactory(normalized)
      : new ElementShim(normalized);
    if (normalized === 'iframe') {
      const document = createDocument({ canvasFactory: this.canvasFactory });
      const contentWindow = { document };
      contentWindow.window = contentWindow;
      contentWindow.self = contentWindow;
      contentWindow.globalThis = contentWindow;
      document.defaultView = contentWindow;
      element.contentWindow = contentWindow;
      element.contentDocument = document;
    }
    return element;
  }

  getElementsByTagName(tagName) {
    const normalized = String(tagName).toLowerCase();
    const elements = [
      this.documentElement,
      ...descendantsOf(this.documentElement)
    ];
    return elements.filter(element =>
      normalized === '*' || element.localName === normalized
    );
  }

  getElementById(id) {
    return this.getElementsByTagName('*').find(
      element => element.getAttribute('id') === String(id)
    ) || null;
  }

  querySelector(selector) {
    return this.getElementsByTagName('*').find(
      element => matchesSelector(element, selector)
    ) || null;
  }
}

function createDocument({ canvasFactory }) {
  return new DocumentShim({ canvasFactory });
}

function createStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      const normalized = String(key);
      return values.has(normalized) ? values.get(normalized) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    }
  };
}

function createRequest(operation) {
  const request = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null
  };
  queueMicrotask(() => operation(request));
  return request;
}

function createIndexedDB() {
  return {
    open(name) {
      return createRequest(request => {
        request.result = {
          name: String(name),
          createObjectStore() {
            return {};
          },
          close() {}
        };
        if (typeof request.onupgradeneeded === 'function') {
          request.onupgradeneeded({ target: request });
        }
        if (typeof request.onsuccess === 'function') {
          request.onsuccess({ target: request });
        }
      });
    },
    deleteDatabase() {
      return createRequest(request => {
        request.result = undefined;
        if (typeof request.onsuccess === 'function') {
          request.onsuccess({ target: request });
        }
      });
    }
  };
}

module.exports = {
  EventTargetShim,
  ElementShim,
  DocumentShim,
  createDocument,
  createStorage,
  createIndexedDB
};
