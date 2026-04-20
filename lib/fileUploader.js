const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { generateId } = require('./helpers');

class FileUploader {
  /**
   * @param {object} options
   * @param {function} options.auth - Auth function: receives (req), must return truthy or throw
   * @param {string[]} [options.allowedTypes] - MIME types: ['image/png', 'image/*', '*']
   * @param {number} [options.maxSize] - Max file size in bytes (default: 5MB)
   * @param {string} [options.destination] - Upload directory (default: './uploads')
   */
  constructor(options = {}) {
    this._auth = options.auth || null;
    this._allowedTypes = options.allowedTypes || ['*'];
    this._maxSize = options.maxSize || 5 * 1024 * 1024;
    this._destination = options.destination || process.env.UPLOAD_DIR || './uploads';

    if (!fs.existsSync(this._destination)) {
      fs.mkdirSync(this._destination, { recursive: true });
    }

    this._multer = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          cb(null, this._destination);
        },
        filename: (req, file, cb) => {
          var ext = path.extname(file.originalname);
          var name = generateId() + ext;
          cb(null, name);
        }
      }),
      limits: {
        fileSize: this._maxSize
      },
      fileFilter: (req, file, cb) => {
        if (this._isTypeAllowed(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new Error('File type not allowed: ' + file.mimetype));
        }
      }
    });
  }

  _isTypeAllowed(mimetype) {
    for (var i = 0; i < this._allowedTypes.length; i++) {
      var allowed = this._allowedTypes[i];
      if (allowed === '*') return true;
      if (allowed.endsWith('/*')) {
        var category = allowed.split('/')[0];
        if (mimetype.startsWith(category + '/')) return true;
      }
      if (allowed === mimetype) return true;
    }
    return false;
  }

  _authGuard() {
    var auth = this._auth;
    return async function(req, res, next) {
      if (!auth) return next();
      try {
        var result = await auth(req);
        if (!result) {
          res.writeHead ? _jsonResponse(res, 401, { error: 'Unauthorized' })
            : res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        next();
      } catch (err) {
        res.writeHead ? _jsonResponse(res, 401, { error: err.message || 'Unauthorized' })
          : res.status(401).json({ error: err.message || 'Unauthorized' });
      }
    };
  }

  _errorHandler() {
    return function(err, req, res, next) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large' });
      }
      if (err.message && err.message.startsWith('File type not allowed')) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message || 'Upload failed' });
    };
  }

  /**
   * Accept a single file upload.
   * @param {string} fieldName - Form field name
   * @returns {function[]} Express middleware chain
   */
  single(fieldName) {
    var guard = this._authGuard();
    var upload = this._multer.single(fieldName);
    var errorHandler = this._errorHandler();
    return [guard, upload, errorHandler];
  }

  /**
   * Accept multiple file uploads on a single field.
   * @param {string} fieldName - Form field name
   * @param {number} [maxCount=10] - Maximum number of files
   * @returns {function[]} Express middleware chain
   */
  array(fieldName, maxCount) {
    var guard = this._authGuard();
    var upload = this._multer.array(fieldName, maxCount || 10);
    var errorHandler = this._errorHandler();
    return [guard, upload, errorHandler];
  }

  /**
   * Accept file uploads on multiple fields.
   * @param {Array<{name: string, maxCount: number}>} fields
   * @returns {function[]} Express middleware chain
   */
  fields(fields) {
    var guard = this._authGuard();
    var upload = this._multer.fields(fields);
    var errorHandler = this._errorHandler();
    return [guard, upload, errorHandler];
  }
}

function _jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

module.exports = FileUploader;
