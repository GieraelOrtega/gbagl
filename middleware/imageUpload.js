const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { pathContains } = require('../config');
const { UPLOAD_MEDIA_TYPES } = require('../lib/hubValidation');

function redirectError(res, destination, message) {
  return res.redirect(303, `${destination}?${new URLSearchParams({ error: message })}`);
}

function createImageUploadIngress({
  accountAuth,
  config,
  errorDestination,
  passcodeAuth,
}) {
  if (typeof errorDestination !== 'string' || !errorDestination.startsWith('/')) {
    throw new Error('Image upload error destination must be an application path');
  }
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const publicDir = path.resolve(__dirname, '..', 'public');
  if (
    fs.existsSync(publicDir)
    && pathContains(fs.realpathSync(publicDir), fs.realpathSync(config.uploadDir))
  ) {
    throw new Error('UPLOAD_DIR resolves inside public/');
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, callback) => callback(
        null,
        `${require('crypto').randomBytes(16).toString('hex')}.upload`,
      ),
    }),
    limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 20 },
    fileFilter: (req, file, callback) => {
      if (UPLOAD_MEDIA_TYPES.includes(file.mimetype)) return callback(null, true);
      const error = new Error('Unsupported photo format');
      error.code = 'UNSUPPORTED_MEDIA_TYPE';
      return callback(error);
    },
  }).single('photo');

  return [
    passcodeAuth.requirePasscode,
    accountAuth.requireMember,
    (req, res, next) => {
      upload(req, res, (error) => {
        if (error) {
          console.error('Photo upload parsing failed:', error.message);
          let message = 'Photo upload could not be read.';
          if (error.code === 'LIMIT_FILE_SIZE') {
            message = `Photo exceeds the ${Math.ceil(config.uploadMaxBytes / 1048576)} MB limit.`;
          } else if (error.code === 'UNSUPPORTED_MEDIA_TYPE') {
            message = 'Choose a JPEG, PNG, WebP, HEIC, or HEIF photo.';
          }
          return redirectError(res, errorDestination, message);
        }
        if (req.file?.path) {
          res.on('finish', () => fs.promises.rm(req.file.path, { force: true }).catch(
            (cleanupError) => console.error(
              'Temporary upload cleanup failed:',
              cleanupError.message,
            ),
          ));
        }
        return next();
      });
    },
  ];
}

module.exports = { createImageUploadIngress };
