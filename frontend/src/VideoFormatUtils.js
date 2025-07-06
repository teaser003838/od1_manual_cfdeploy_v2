// Video Format Detection and Compatibility Utilities

export const VideoFormatUtils = {
  // Detect file format from filename or MIME type
  detectFormat: (filename, mimeType = '') => {
    const name = filename.toLowerCase();
    
    if (name.endsWith('.mp4') || name.endsWith('.m4v')) {
      return { format: 'mp4', mime: 'video/mp4', compatibility: 'excellent' };
    }
    if (name.endsWith('.webm')) {
      return { format: 'webm', mime: 'video/webm', compatibility: 'good' };
    }
    if (name.endsWith('.mkv')) {
      return { format: 'mkv', mime: 'video/x-matroska', compatibility: 'limited' };
    }
    if (name.endsWith('.avi')) {
      return { format: 'avi', mime: 'video/x-msvideo', compatibility: 'poor' };
    }
    if (name.endsWith('.mov')) {
      return { format: 'mov', mime: 'video/quicktime', compatibility: 'fair' };
    }
    if (name.endsWith('.wmv')) {
      return { format: 'wmv', mime: 'video/x-ms-wmv', compatibility: 'poor' };
    }
    if (name.endsWith('.flv')) {
      return { format: 'flv', mime: 'video/x-flv', compatibility: 'poor' };
    }
    if (name.endsWith('.3gp')) {
      return { format: '3gp', mime: 'video/3gpp', compatibility: 'poor' };
    }
    
    // Audio formats
    if (name.endsWith('.mp3')) {
      return { format: 'mp3', mime: 'audio/mpeg', compatibility: 'excellent' };
    }
    if (name.endsWith('.wav')) {
      return { format: 'wav', mime: 'audio/wav', compatibility: 'good' };
    }
    if (name.endsWith('.flac')) {
      return { format: 'flac', mime: 'audio/flac', compatibility: 'fair' };
    }
    if (name.endsWith('.m4a')) {
      return { format: 'm4a', mime: 'audio/mp4', compatibility: 'good' };
    }
    if (name.endsWith('.ogg')) {
      return { format: 'ogg', mime: 'audio/ogg', compatibility: 'fair' };
    }
    
    return { format: 'unknown', mime: mimeType || 'application/octet-stream', compatibility: 'unknown' };
  },

  // Check browser compatibility for specific formats
  getBrowserCompatibility: () => {
    const video = document.createElement('video');
    const audio = document.createElement('audio');
    
    return {
      // Video formats
      mp4: video.canPlayType('video/mp4') !== '',
      webm: video.canPlayType('video/webm') !== '',
      mkv: video.canPlayType('video/x-matroska') !== '',
      avi: video.canPlayType('video/x-msvideo') !== '',
      mov: video.canPlayType('video/quicktime') !== '',
      
      // Audio formats
      mp3: audio.canPlayType('audio/mpeg') !== '',
      wav: audio.canPlayType('audio/wav') !== '',
      flac: audio.canPlayType('audio/flac') !== '',
      m4a: audio.canPlayType('audio/mp4') !== '',
      ogg: audio.canPlayType('audio/ogg') !== '',
    };
  },

  // Detect device and browser specifics
  getDeviceInfo: () => {
    const userAgent = navigator.userAgent.toLowerCase();
    
    return {
      isMobile: /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent),
      isTablet: /ipad|android(?!.*mobile)/i.test(userAgent),
      isChrome: /chrome|crios/i.test(userAgent) && !/edg/i.test(userAgent),
      isFirefox: /firefox/i.test(userAgent),
      isSafari: /safari/i.test(userAgent) && !/chrome/i.test(userAgent),
      isEdge: /edg/i.test(userAgent),
      isMobileChrome: /chrome|crios/i.test(userAgent) && /mobile/i.test(userAgent),
      isMobileSafari: /safari/i.test(userAgent) && /mobile/i.test(userAgent) && !/chrome/i.test(userAgent),
      isAndroid: /android/i.test(userAgent),
      isIOS: /iphone|ipad|ipod/i.test(userAgent),
    };
  },

  // Get compatibility warnings and recommendations
  getCompatibilityWarning: (filename) => {
    const format = VideoFormatUtils.detectFormat(filename);
    const device = VideoFormatUtils.getDeviceInfo();
    const browserSupport = VideoFormatUtils.getBrowserCompatibility();

    const warnings = [];
    const recommendations = [];

    // MKV-specific warnings
    if (format.format === 'mkv') {
      if (device.isMobileChrome) {
        warnings.push('MKV files may not display video on mobile Chrome browsers');
        warnings.push('Audio will likely work, but video may show as black screen');
        recommendations.push('Try using Firefox mobile or convert file to MP4');
      } else if (device.isMobileSafari) {
        warnings.push('MKV files are not supported on Safari mobile');
        recommendations.push('Convert file to MP4 for iOS compatibility');
      } else if (!browserSupport.mkv) {
        warnings.push('Your browser may not support MKV format');
        recommendations.push('Try a different browser or convert to MP4');
      }
    }

    // AVI warnings
    if (format.format === 'avi') {
      if (device.isMobile) {
        warnings.push('AVI files have poor mobile browser support');
        recommendations.push('Convert to MP4 or WebM for better compatibility');
      }
    }

    // WMV warnings
    if (format.format === 'wmv') {
      if (!device.isEdge) {
        warnings.push('WMV files are primarily supported in Microsoft Edge');
        recommendations.push('Convert to MP4 for universal compatibility');
      }
    }

    // General mobile warnings
    if (device.isMobile && format.compatibility === 'poor') {
      warnings.push('This video format may not work well on mobile devices');
      recommendations.push('Consider using MP4 format for mobile compatibility');
    }

    return {
      format: format.format,
      compatibility: format.compatibility,
      warnings,
      recommendations,
      isSupported: browserSupport[format.format] !== false,
      deviceInfo: device
    };
  },

  // Get optimized streaming parameters based on format and device
  getStreamingParams: (filename, fileSize = 0) => {
    const format = VideoFormatUtils.detectFormat(filename);
    const device = VideoFormatUtils.getDeviceInfo();
    
    let chunkSize = 65536; // 64KB default
    let preload = 'metadata';
    let bufferSize = 'auto';
    
    // Format-specific optimizations
    if (format.format === 'mkv') {
      if (device.isMobileChrome) {
        chunkSize = 32768; // 32KB for mobile Chrome MKV
        preload = 'none'; // Don't preload on mobile Chrome for MKV
      } else {
        chunkSize = 65536; // 64KB for desktop MKV
      }
    } else if (format.format === 'mp4') {
      chunkSize = 131072; // 128KB for MP4 (better support)
      preload = 'metadata';
    }
    
    // File size optimizations
    if (fileSize > 500 * 1024 * 1024) { // > 500MB
      chunkSize = Math.max(chunkSize, 1024 * 1024); // At least 1MB
      preload = 'none';
    } else if (fileSize > 100 * 1024 * 1024) { // > 100MB
      chunkSize = Math.max(chunkSize, 512 * 1024); // At least 512KB
    }
    
    // Mobile optimizations
    if (device.isMobile) {
      chunkSize = Math.min(chunkSize, 512 * 1024); // Max 512KB on mobile
      if (device.isMobileChrome && format.format === 'mkv') {
        preload = 'none';
        bufferSize = 'small';
      }
    }
    
    return {
      chunkSize,
      preload,
      bufferSize,
      supportsRangeRequests: format.format !== 'flv', // FLV doesn't support range requests well
      maxConcurrentConnections: device.isMobile ? 2 : 4,
      timeout: format.format === 'mkv' ? 180000 : 120000, // Longer timeout for MKV
    };
  },

  // Create error messages with helpful information
  createErrorMessage: (filename, error = '') => {
    const compatibility = VideoFormatUtils.getCompatibilityWarning(filename);
    const device = compatibility.deviceInfo;
    
    let message = 'Video playback failed. ';
    
    if (compatibility.format === 'mkv') {
      if (device.isMobileChrome) {
        message = 'MKV video not supported on mobile Chrome. The audio track is available, but video display is not supported. ';
      } else if (device.isMobileSafari) {
        message = 'MKV format is not supported on Safari mobile. ';
      } else {
        message = 'MKV playback error. Your browser may have limited MKV support. ';
      }
    } else if (compatibility.format === 'avi') {
      message = 'AVI format has limited browser support. ';
    } else if (compatibility.format === 'wmv') {
      message = 'WMV format is primarily supported in Microsoft Edge. ';
    }
    
    if (compatibility.recommendations.length > 0) {
      message += '\n\nRecommendations:\n' + compatibility.recommendations.join('\n');
    }
    
    if (error) {
      message += '\n\nTechnical error: ' + error;
    }
    
    return message;
  },

  // Log format information for debugging
  logFormatInfo: (filename, fileSize = 0) => {
    const format = VideoFormatUtils.detectFormat(filename);
    const device = VideoFormatUtils.getDeviceInfo();
    const browserSupport = VideoFormatUtils.getBrowserCompatibility();
    const streaming = VideoFormatUtils.getStreamingParams(filename, fileSize);
    
    console.group(`🎬 Video Format Analysis: ${filename}`);
    console.log('Format:', format);
    console.log('Device:', device);
    console.log('Browser Support:', browserSupport);
    console.log('Streaming Params:', streaming);
    console.groupEnd();
    
    return { format, device, browserSupport, streaming };
  }
};

export default VideoFormatUtils;