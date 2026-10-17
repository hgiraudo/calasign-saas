import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../config";

export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Borra el objeto (retención). No falla si ya no existe. */
  delete(key: string): Promise<void>;
}

class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root)) throw new Error("clave inválida");
    return p;
  }
  async put(key: string, data: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string) {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

class S3BlobStore implements BlobStore {
  private clientP = import("@aws-sdk/client-s3").then((m) => ({ m, c: new m.S3Client({ region: config.storage.region }) }));
  constructor(
    private bucket: string,
    private prefix: string,
  ) {}
  async put(key: string, data: Uint8Array, contentType: string) {
    const { m, c } = await this.clientP;
    await c.send(
      new m.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: data,
        ContentType: contentType,
        ServerSideEncryption: "aws:kms",
      }),
    );
  }
  async get(key: string) {
    const { m, c } = await this.clientP;
    const r = await c.send(new m.GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
    return new Uint8Array(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    const { m, c } = await this.clientP;
    await c.send(new m.DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
  }
}

export function createBlobStore(): BlobStore {
  if (config.storage.driver === "s3") {
    if (!config.storage.bucket) throw new Error("S3_BUCKET requerido");
    return new S3BlobStore(config.storage.bucket, config.storage.prefix);
  }
  return new LocalBlobStore(resolve(config.dataDir, "blobs"));
}
