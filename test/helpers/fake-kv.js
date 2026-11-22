export function createFakeKv() {
  const data = new Map();
  const writes = [];
  return {
    data,
    writes,
    async get(key, type) {
      if (!data.has(key)) return null;
      const value = data.get(key).value;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, options = {}) {
      writes.push({ key, options });
      data.set(key, { value: String(value), options });
    },
    async delete(key) {
      data.delete(key);
    },
  };
}
