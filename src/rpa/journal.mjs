import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 每条交接资料一个独立执行记录，恢复只依赖这些文件与门户查询，不依赖内存进度。
// 先写临时文件再改名，崩溃不会留下半份记录；记录只保存阶段与内容哈希，不保存联系人。
export class Journal {
  constructor(directory) {
    this.directory = directory;
  }

  pathFor(requestKey) {
    return join(this.directory, `state-${encodeURIComponent(requestKey)}.json`);
  }

  async read(requestKey) {
    let text;
    try {
      text = await readFile(this.pathFor(requestKey), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { requestKey, stage: 'corrupt', reason: '执行记录无法读取，暂停交人工' };
    }
    try {
      const value = JSON.parse(text);
      if (value.requestKey !== requestKey) throw new Error('业务键不符');
      return value;
    } catch {
      return { requestKey, stage: 'corrupt', reason: '执行记录损坏，暂停交人工' };
    }
  }

  async write(state) {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(state.requestKey);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    await rename(temporary, path);
    return state;
  }
}
