const path = require('path');
const { safeUploadPath } = require('./media');
const { imagePath } = require('./validation');

const UPLOAD_MEDIA_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});
const EXISTING_MEDIA_TYPES = Object.freeze({
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
});

function timelinePhotoDetails(config, milestone) {
  if (!milestone?.photo) throw new Error('Timeline milestone has no photo');
  const storageType = milestone.photo_storage_type || 'existing';

  if (storageType === 'upload') {
    const extension = UPLOAD_MEDIA_EXTENSIONS[milestone.photo_media_type];
    if (!extension) throw new Error('Invalid uploaded timeline photo type');
    const filePath = safeUploadPath(config.uploadDir, milestone.photo);
    if (path.extname(filePath).toLowerCase() !== `.${extension}`) {
      throw new Error('Uploaded timeline photo metadata does not match its file');
    }
    return {
      extension,
      filePath,
      mediaType: milestone.photo_media_type,
      root: path.resolve(config.uploadDir),
      storageType,
    };
  }

  if (storageType !== 'existing') throw new Error('Invalid timeline photo storage type');
  const relativePath = imagePath(milestone.photo);
  if (!relativePath) throw new Error('Invalid existing timeline photo path');
  const publicRoot = path.resolve(config.publicDir || path.join(__dirname, '..', 'public'));
  const filePath = path.resolve(publicRoot, relativePath);
  const relative = path.relative(publicRoot, filePath);
  if (
    relative.startsWith(`..${path.sep}`)
    || relative === '..'
    || path.isAbsolute(relative)
  ) throw new Error('Invalid existing timeline photo path');
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const mediaType = EXISTING_MEDIA_TYPES[extension];
  if (!mediaType) throw new Error('Invalid existing timeline photo type');
  return {
    extension: extension === 'jpeg' ? 'jpg' : extension,
    filePath,
    mediaType,
    root: publicRoot,
    storageType,
  };
}

module.exports = { timelinePhotoDetails };
