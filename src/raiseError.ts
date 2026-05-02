export function raiseError(message: string): never {
  throw new Error(`[@csbc-dev/s3-uploader] ${message}`);
}
