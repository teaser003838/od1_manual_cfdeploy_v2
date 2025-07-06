import React, { useState, useEffect, useRef, useCallback } from 'react';
import VideoFormatUtils from './VideoFormatUtils';
import './LightweightVideoPlayer.css';

const LightweightVideoPlayer = ({ video, backendUrl, accessToken, onBack, onNextVideo, playlist = [] }) => {
  // Essential state only
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Refs
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const progressBarRef = useRef(null);
  const hideControlsTimer = useRef(null);

  // Device detection and format analysis
  const deviceInfo = VideoFormatUtils.getDeviceInfo();
  const formatInfo = VideoFormatUtils.detectFormat(video.name);
  const compatibilityInfo = VideoFormatUtils.getCompatibilityWarning(video.name);
  const streamingParams = VideoFormatUtils.getStreamingParams(video.name, video.size);
  
  const isMobile = deviceInfo.isMobile;
  const isMobileChrome = deviceInfo.isMobileChrome;
  const isMKV = formatInfo.format === 'mkv';
  const hasCompatibilityIssues = compatibilityInfo.warnings.length > 0;

  // Log format information for debugging
  useEffect(() => {
    VideoFormatUtils.logFormatInfo(video.name, video.size);
  }, [video.name, video.size]);

  // Build optimized video URL
  const getVideoUrl = useCallback(() => {
    return `${backendUrl}/api/stream/${video.id}?token=${accessToken}`;
  }, [backendUrl, video.id, accessToken]);

  // Essential video event handlers
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleLoadStart = () => {
      setIsLoading(true);
      setError('');
    };

    const handleLoadedMetadata = () => {
      setDuration(videoElement.duration);
      setIsLoading(false);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(videoElement.currentTime);
    };

    const handlePlay = () => {
      setIsPlaying(true);
      setIsBuffering(false);
    };

    const handlePause = () => {
      setIsPlaying(false);
    };

    const handleWaiting = () => {
      setIsBuffering(true);
    };

    const handleCanPlay = () => {
      setIsBuffering(false);
    };

    const handleError = (e) => {
      console.error('Video error:', e);
      setIsLoading(false);
      setIsBuffering(false);
      
      // Enhanced error handling with format-specific messages
      const errorMessage = VideoFormatUtils.createErrorMessage(video.name, e.target?.error?.message);
      setError(errorMessage);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      // Auto-play next video if available
      if (onNextVideo && playlist.length > 0) {
        setTimeout(() => onNextVideo(playlist[0]), 1000);
      }
    };

    // Add event listeners
    videoElement.addEventListener('loadstart', handleLoadStart);
    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('waiting', handleWaiting);
    videoElement.addEventListener('canplay', handleCanPlay);
    videoElement.addEventListener('error', handleError);
    videoElement.addEventListener('ended', handleEnded);

    return () => {
      videoElement.removeEventListener('loadstart', handleLoadStart);
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('waiting', handleWaiting);
      videoElement.removeEventListener('canplay', handleCanPlay);
      videoElement.removeEventListener('error', handleError);
      videoElement.removeEventListener('ended', handleEnded);
    };
  }, [video.id, onNextVideo, playlist, formatInfo.format, deviceInfo.isMobileChrome]);

  // Keyboard shortcuts - optimized
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.target.tagName === 'INPUT') return;
      
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekRelative(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekRelative(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustVolume(-0.1);
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'KeyM':
          e.preventDefault();
          toggleMute();
          break;
        case 'Escape':
          if (isFullscreen) {
            e.preventDefault();
            exitFullscreen();
          }
          break;
        default:
          // Number keys for percentage seeking
          if (e.code.startsWith('Digit')) {
            const digit = parseInt(e.code.replace('Digit', ''));
            if (digit >= 0 && digit <= 9) {
              e.preventDefault();
              seekToPercentage(digit * 10);
            }
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  }, [isFullscreen]);

  // Fullscreen change handler
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      showControlsTemporarily();
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Control functions - optimized
  const togglePlay = async () => {
    if (!videoRef.current) return;
    
    try {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        await videoRef.current.play();
      }
    } catch (error) {
      console.error('Play error:', error);
      setError('Playback failed. Please try again.');
    }
  };

  const seekRelative = (seconds) => {
    if (!videoRef.current || !duration) return;
    
    const newTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + seconds));
    videoRef.current.currentTime = newTime;
    showControlsTemporarily();
  };

  const seekToPercentage = (percentage) => {
    if (!videoRef.current || !duration) return;
    
    const newTime = (percentage / 100) * duration;
    videoRef.current.currentTime = newTime;
    showControlsTemporarily();
  };

  const handleSeek = (e) => {
    if (!videoRef.current || !duration || !progressBarRef.current) return;
    
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = Math.max(0, Math.min(duration, percent * duration));
    
    videoRef.current.currentTime = newTime;
    showControlsTemporarily();
  };

  const adjustVolume = (delta) => {
    const newVolume = Math.max(0, Math.min(1, volume + delta));
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      setIsMuted(newVolume === 0);
    }
    showControlsTemporarily();
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    
    if (isMuted) {
      videoRef.current.volume = volume;
      setIsMuted(false);
    } else {
      videoRef.current.volume = 0;
      setIsMuted(true);
    }
    showControlsTemporarily();
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const exitFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  };

  // Control visibility - simplified
  const showControlsTemporarily = () => {
    setShowControls(true);
    
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    
    // Only auto-hide in fullscreen mode
    if (isFullscreen) {
      hideControlsTimer.current = setTimeout(() => {
        if (isPlaying) {
          setShowControls(false);
        }
      }, 3000);
    }
  };

  const handleMouseMove = () => {
    if (!isMobile) {
      showControlsTemporarily();
    }
  };

  const handleContainerClick = () => {
    if (isMobile) {
      setShowControls(true);
      showControlsTemporarily();
    } else {
      togglePlay();
    }
  };

  // Utility functions
  const formatTime = (time) => {
    if (isNaN(time)) return '0:00';
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div 
      className={`lightweight-player ${isFullscreen ? 'fullscreen' : ''}`}
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onClick={handleContainerClick}
    >
      {/* Video Element with optimizations */}
      <video
        ref={videoRef}
        className="video-element"
        src={getVideoUrl()}
        preload={streamingParams.preload}
        crossOrigin="anonymous"
        playsInline
        {...(isMKV && isMobileChrome ? {
          'webkit-playsinline': true,
          'x5-playsinline': true,
          'x5-video-player-type': 'h5'
        } : {})}
      />

      {/* Loading Overlay */}
      {isLoading && (
        <div className="overlay loading-overlay">
          <div className="spinner"></div>
          <div className="loading-text">Loading video...</div>
          {hasCompatibilityIssues && (
            <div className="format-warning">
              {compatibilityInfo.warnings[0]}
            </div>
          )}
        </div>
      )}

      {/* Buffering Overlay */}
      {isBuffering && !isLoading && (
        <div className="overlay buffering-overlay">
          <div className="spinner"></div>
          <div className="buffering-text">Buffering...</div>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="overlay error-overlay">
          <div className="error-content">
            <div className="error-icon">⚠️</div>
            <div className="error-message">{error}</div>
            <button 
              className="retry-button"
              onClick={() => {
                setError('');
                setIsLoading(true);
                if (videoRef.current) {
                  videoRef.current.load();
                }
              }}
            >
              Try Again
            </button>
            {hasCompatibilityIssues && (
              <div className="format-help">
                <p><strong>Format:</strong> {formatInfo.format.toUpperCase()} - {compatibilityInfo.compatibility} compatibility</p>
                {compatibilityInfo.recommendations.map((rec, index) => (
                  <p key={index}>• {rec}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className={`controls ${showControls ? 'visible' : 'hidden'}`}>
        {/* Top Bar */}
        <div className="top-bar">
          <button className="back-button" onClick={onBack}>
            ← Back
          </button>
          <div className="video-title">{video.name}</div>
        </div>

        {/* Center Play Button */}
        {!isPlaying && !isBuffering && !isLoading && (
          <div className="center-play">
            <button className="play-button" onClick={togglePlay}>
              ▶
            </button>
          </div>
        )}

        {/* Bottom Controls */}
        <div className="bottom-controls">
          {/* Progress Bar */}
          <div 
            className="progress-bar"
            ref={progressBarRef}
            onClick={handleSeek}
          >
            <div 
              className="progress-fill"
              style={{ width: `${(currentTime / duration) * 100}%` }}
            />
            <div 
              className="progress-handle"
              style={{ left: `${(currentTime / duration) * 100}%` }}
            />
          </div>

          {/* Control Buttons */}
          <div className="control-row">
            <div className="left-controls">
              <button className="control-btn" onClick={togglePlay}>
                {isPlaying ? '⏸️' : '▶️'}
              </button>
              
              <button className="control-btn" onClick={() => seekRelative(-10)}>
                ⏪
              </button>
              
              <button className="control-btn" onClick={() => seekRelative(10)}>
                ⏩
              </button>
              
              <button className="control-btn" onClick={toggleMute}>
                {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
              </button>
              
              <div className="time-display">
                {formatTime(currentTime)} / {formatTime(duration)}
              </div>
            </div>

            <div className="right-controls">
              <button className="control-btn" onClick={toggleFullscreen}>
                {isFullscreen ? '🗗' : '⛶'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Video Info */}
      {!isFullscreen && (
        <div className="video-info">
          <div className="info-title">{video.name}</div>
          <div className="info-details">
            <span>Size: {formatFileSize(video.size)}</span>
            <span className={`format-tag ${compatibilityInfo.compatibility}`}>
              {formatInfo.format.toUpperCase()}
            </span>
            {deviceInfo.isMobileChrome && formatInfo.format === 'mkv' && (
              <span className="mobile-warning">Mobile Chrome</span>
            )}
            {hasCompatibilityIssues && (
              <span className="compatibility-warning" title={compatibilityInfo.warnings.join(', ')}>
                ⚠️ Limited Support
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LightweightVideoPlayer;