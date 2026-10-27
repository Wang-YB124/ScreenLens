const fs = require('fs');
const path = require('path');

class HistoryStore {
  constructor({ dir, limit = 60 }) {
    this.dir = dir;
    this.imagesDir = path.join(dir, 'images');
    this.file = path.join(dir, 'history.json');
    this.limit = limit;
    fs.mkdirSync(this.imagesDir, { recursive: true });
    this.records = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw.filter((item) => item && item.id && this.imageExists(item));
    } catch {
      return [];
    }
  }

  imageExists(record) {
    return Boolean(record.image) && fs.existsSync(path.join(this.imagesDir, record.image));
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  setLimit(limit) {
    this.limit = limit;
    this.trim();
    this.save();
  }

  trim() {
    const extra = this.records.splice(this.limit);
    for (const record of extra) this.deleteImages(record);
  }

  deleteImages(record) {
    if (!record) return;
    for (const name of record.image ? [record.image, record.thumb] : []) {
      if (!name) continue;
      try { fs.unlinkSync(path.join(this.imagesDir, name)); } catch {}
    }
  }

  saveImages(id, pngBuffer, thumbBuffer) {
    const image = `${id}.png`;
    const thumb = `${id}.jpg`;
    fs.writeFileSync(path.join(this.imagesDir, image), pngBuffer);
    if (thumbBuffer) fs.writeFileSync(path.join(this.imagesDir, thumb), thumbBuffer);
    return { image, thumb: thumbBuffer ? thumb : null };
  }

  add(record) {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index >= 0) this.records.splice(index, 1);
    this.records.unshift(record);
    this.trim();
    this.save();
  }

  update(id, patch) {
    const index = this.records.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.records[index] = { ...this.records[index], ...patch, updatedAt: Date.now() };
    this.save();
    return this.records[index];
  }

  get(id) {
    return this.records.find((item) => item.id === id) || null;
  }

  list() {
    return this.records.map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      source: record.source || '',
      translation: record.translation || '',
      sourceLang: record.sourceLang || '',
      targetLang: record.targetLang || '',
      thumbUrl: record.thumb ? `shot://thumb/${record.thumb}` : '',
      imageUrl: record.image ? `shot://history/${record.image}` : '',
    }));
  }

  remove(id) {
    const index = this.records.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [record] = this.records.splice(index, 1);
    this.deleteImages(record);
    this.save();
    return true;
  }

  clear() {
    for (const record of this.records) this.deleteImages(record);
    this.records = [];
    this.save();
  }

  resolveImage(host, filename) {
    const record = this.records.find(
      (item) => item.image === filename || item.thumb === filename,
    );
    if (!record) return null;
    if (host === 'thumb' && record.thumb !== filename) return null;
    const filePath = path.join(this.imagesDir, filename);
    return fs.existsSync(filePath) ? filePath : null;
  }
}

module.exports = { HistoryStore };
