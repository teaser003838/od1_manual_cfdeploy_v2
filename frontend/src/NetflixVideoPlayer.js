import React, { useState, useRef, useEffect, useCallback } from 'react';
import VideoFormatUtils from './VideoFormatUtils';
import './NetflixVideoPlayer.css';

const NetflixVideoPlayer = ({ video, backendUrl, accessToken, onBack, onNextVideo, playlist = [] }) => {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const progressBarRef = useRef(null);
  const volumeBeforeTimelineSeek = useRef(1);
  
  // Core player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  
  // Advanced player state
  const [currentQuality, setCurrentQuality] = useState('Auto');
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferedRanges, setBufferedRanges] = useState([]);
  const [error, setError] = useState('');
  const [isPiPMode, setIsPiPMode] = useState(false);
  
  // UI state
  const [showControls, setShowControls] = useState(true);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  
  // Advanced UI state
  const [previewTime, setPreviewTime] = useState(null);
  const [previewThumbnail, setPreviewThumbnail] = useState(null);
  const [showSkipIntro, setShowSkipIntro] = useState(false);
  const [showSkipOutro, setShowSkipOutro] = useState(false);
  const [autoplayCountdown, setAutoplayCountdown] = useState(null);
  const [showUpNext, setShowUpNext] = useState(false);
  
  // Subtitle state
  const [subtitles, setSubtitles] = useState([]);
  const [currentSubtitle, setCurrentSubtitle] = useState(null);
  const [subtitleStyle, setSubtitleStyle] = useState({
    fontSize: '16px',
    color: '#ffffff',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    fontFamily: 'Netflix Sans, Arial, sans-serif'
  });
  
  // Mobile detection
  const [isMobile, setIsMobile] = useState(false);
  
  // Timers
  const hideControlsTimer = useRef(null);
  const autoplayTimer = useRef(null);
  
  // Quality and playback options
  const qualityOptions = ['Auto', '1080p', '720p', '480p', '360p'];
  const playbackRates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  
  // Device and format detection
  const deviceInfo = VideoFormatUtils.getDeviceInfo();
  const formatInfo = VideoFormatUtils.detectFormat(video.name);
  const compatibilityInfo = VideoFormatUtils.getCompatibilityWarning(video.name);
  const streamingParams = VideoFormatUtils.getStreamingParams(video.name, video.size);
  
  // Device-specific flags
  const isMobile = deviceInfo.isMobile;
  const isMobileChrome = deviceInfo.isMobileChrome;
  const hasCompatibilityIssues = compatibilityInfo.warnings.length > 0;
  
  // Log format information for debugging
  useEffect(() => {
    VideoFormatUtils.logFormatInfo(video.name, video.size);
  }, [video.name, video.size]);

  // Initialize player
  useEffect(() => {
    const checkMobile = () => {
      const isMobileDevice = window.innerWidth <= 768 || 
                            ('ontouchstart' in window) || 
                            (navigator.maxTouchPoints > 0);
      setIsMobile(isMobileDevice);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    
    // Load subtitles
    loadSubtitles();
    
    return () => {
      window.removeEventListener('resize', checkMobile);
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
      if (autoplayTimer.current) clearTimeout(autoplayTimer.current);
    };
  }, []);

  // Video event handlers
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleLoadedMetadata = () => {
      setDuration(videoElement.duration);
      setError('');
      showControlsTemporarily();
      
      // Detect intro/outro sections (simplified logic)
      if (videoElement.duration > 60) {
        setShowSkipIntro(true);
        setTimeout(() => setShowSkipIntro(false), 30000); // Hide after 30s
      }
    };

    const handleTimeUpdate = () => {
      const currentTime = videoElement.currentTime;
      setCurrentTime(currentTime);
      
      // Update buffered ranges
      const buffered = videoElement.buffered;
      const ranges = [];
      for (let i = 0; i < buffered.length; i++) {
        ranges.push({
          start: buffered.start(i),
          end: buffered.end(i)
        });
      }
      setBufferedRanges(ranges);
      
      // Show skip outro in last 2 minutes
      if (duration - currentTime < 120 && duration - currentTime > 60) {
        setShowSkipOutro(true);
      } else {
        setShowSkipOutro(false);
      }
      
      // Show up next in last 30 seconds
      if (duration - currentTime < 30 && playlist.length > 0) {
        setShowUpNext(true);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
      setIsBuffering(false);
      setError('');
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

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      
      // Auto-play next video if available
      if (playlist.length > 0 && onNextVideo) {
        startAutoplayCountdown();
      }
    };

    const handleError = (e) => {
      console.error('Video error:', e);
      setIsPlaying(false);
      setIsBuffering(false);
      
      const videoSrc = videoElement.src;
      const isMkvFile = videoSrc.includes('.mkv') || video.name.toLowerCase().endsWith('.mkv');
      
      if (isMkvFile) {
        setError('MKV file format may not be supported in this browser. Try Chrome, Firefox, or Edge.');
      } else {
        setError('Video playback error. Trying to recover...');
        
        // Auto-retry logic
        setTimeout(() => {
          if (videoElement.src) {
            videoElement.load();
          }
        }, 2000);
      }
    };

    const handleProgress = () => {
      setIsBuffering(false);
    };

    // Attach event listeners
    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('waiting', handleWaiting);
    videoElement.addEventListener('canplay', handleCanPlay);
    videoElement.addEventListener('ended', handleEnded);
    videoElement.addEventListener('error', handleError);
    videoElement.addEventListener('progress', handleProgress);

    return () => {
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('waiting', handleWaiting);
      videoElement.removeEventListener('canplay', handleCanPlay);
      videoElement.removeEventListener('ended', handleEnded);
      videoElement.removeEventListener('error', handleError);
      videoElement.removeEventListener('progress', handleProgress);
    };
  }, [video.id, duration, playlist, onNextVideo]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.target.tagName === 'INPUT') return;
      
      switch (e.code) {
        case 'Space':
        case 'KeyK':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'KeyJ':
          e.preventDefault();
          skipTime(-10);
          break;
        case 'ArrowRight':
        case 'KeyL':
          e.preventDefault();
          skipTime(10);
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
        case 'KeyP':
          e.preventDefault();
          togglePictureInPicture();
          break;
        case 'KeyS':
          e.preventDefault();
          setShowSubtitleMenu(!showSubtitleMenu);
          break;
        case 'Escape':
          e.preventDefault();
          if (isFullscreen) {
            exitFullscreen();
          }
          break;
        default:
          // Number keys for seeking to percentage
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
  }, [isFullscreen, showSubtitleMenu]);

  // Fullscreen change handler
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFullscreenNow = !!document.fullscreenElement;
      setIsFullscreen(isFullscreenNow);
      showControlsTemporarily();
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Player control functions
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
      setError(`Failed to play video: ${error.message}`);
    }
  };

  const skipTime = (seconds) => {
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

  const handleProgressHover = (e) => {
    if (!duration || !progressBarRef.current) return;
    
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const hoverTime = Math.max(0, Math.min(duration, percent * duration));
    
    setPreviewTime(hoverTime);
    // In a real implementation, you would generate thumbnail previews
    // setPreviewThumbnail(generateThumbnailUrl(hoverTime));
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
      volumeBeforeTimelineSeek.current = volume;
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

  const togglePictureInPicture = async () => {
    if (!videoRef.current) return;
    
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPiPMode(false);
      } else {
        await videoRef.current.requestPictureInPicture();
        setIsPiPMode(true);
      }
    } catch (error) {
      console.error('Picture-in-Picture error:', error);
    }
  };

  const changeQuality = (quality) => {
    if (videoRef.current && quality !== currentQuality) {
      const wasPlaying = !videoRef.current.paused;
      const currentTimeStamp = videoRef.current.currentTime;
      
      setCurrentQuality(quality);
      setShowQualityMenu(false);
      setIsBuffering(true);
      
      // Update video source with quality parameter
      const newSrc = getQualityUrl(video.id, quality);
      videoRef.current.src = newSrc;
      videoRef.current.currentTime = currentTimeStamp;
      
      if (wasPlaying) {
        videoRef.current.play().then(() => {
          setIsBuffering(false);
        }).catch((error) => {
          console.error('Error resuming playback after quality change:', error);
          setIsBuffering(false);
        });
      } else {
        setIsBuffering(false);
      }
      
      showControlsTemporarily();
    }
  };

  const changePlaybackRate = (rate) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
      setPlaybackRate(rate);
      showControlsTemporarily();
    }
  };

  const skipIntro = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = 90; // Skip to 1:30
      setShowSkipIntro(false);
    }
  };

  const skipOutro = () => {
    if (onNextVideo && playlist.length > 0) {
      onNextVideo(playlist[0]);
    }
  };

  const startAutoplayCountdown = () => {
    setAutoplayCountdown(15);
    
    autoplayTimer.current = setInterval(() => {
      setAutoplayCountdown(prev => {
        if (prev <= 1) {
          clearInterval(autoplayTimer.current);
          if (onNextVideo && playlist.length > 0) {
            onNextVideo(playlist[0]);
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const cancelAutoplay = () => {
    if (autoplayTimer.current) {
      clearInterval(autoplayTimer.current);
      setAutoplayCountdown(null);
    }
  };

  // Load subtitles
  const loadSubtitles = async () => {
    try {
      const response = await fetch(`${backendUrl}/api/subtitles/${video.id}?token=${accessToken}`);
      if (response.ok) {
        const data = await response.json();
        setSubtitles(data.subtitles || []);
      }
    } catch (error) {
      console.error('Failed to load subtitles:', error);
    }
  };

  const selectSubtitle = (subtitle) => {
    setCurrentSubtitle(subtitle);
    setShowSubtitleMenu(false);
    showControlsTemporarily();
  };

  // Control visibility
  const showControlsTemporarily = () => {
    setShowControls(true);
    
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    
    hideControlsTimer.current = setTimeout(() => {
      if (isPlaying && !showQualityMenu && !showSubtitleMenu && !showSettingsMenu) {
        setShowControls(false);
      }
    }, 3000);
  };

  const handleMouseMove = () => {
    if (!isMobile) {
      showControlsTemporarily();
    }
  };

  // Container touch handlers for mobile fullscreen
  const handleContainerTouch = (e) => {
    if (!isMobile) return;
    
    // Always show controls when touching anywhere in the container
    setShowControls(true);
    showControlsTemporarily();
  };

  const handleContainerClick = (e) => {
    if (!isMobile) return;
    
    // Show controls when clicking anywhere in the container (including video)
    setShowControls(true);
    showControlsTemporarily();
    
    // If clicking directly on video, also toggle play/pause
    if (e.target === videoRef.current) {
      togglePlay();
    }
  };

  // Utility functions
  const getQualityUrl = (videoId, quality) => {
    const baseUrl = `${backendUrl}/api/stream/${videoId}?token=${accessToken}`;
    if (quality === 'Auto') {
      return baseUrl;
    }
    return `${baseUrl}&quality=${quality.toLowerCase()}`;
  };

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
      className={`netflix-player-container ${isFullscreen ? 'fullscreen' : ''}`}
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => !isMobile && isPlaying && setShowControls(false)}
      onTouchStart={handleContainerTouch}
      onTouchEnd={handleContainerTouch}
      onClick={handleContainerClick}
    >
      {/* Touch overlay for mobile fullscreen black areas */}
      {isMobile && isFullscreen && (
        <div 
          className="netflix-touch-overlay"
          onTouchStart={handleContainerTouch}
          onTouchEnd={handleContainerTouch}
          onClick={handleContainerClick}
        />
      )}

      {/* Video Element */}
      <video
        ref={videoRef}
        className="netflix-video"
        src={getQualityUrl(video.id, currentQuality)}
        preload="metadata"
        crossOrigin="anonymous"
        playsInline
        onClick={!isMobile ? togglePlay : undefined}
      />

      {/* Loading Overlay */}
      {isBuffering && (
        <div className="netflix-loading-overlay">
          <div className="netflix-spinner">
            <div className="netflix-spinner-circle"></div>
          </div>
          <div className="netflix-loading-text">Loading...</div>
        </div>
      )}

      {/* Error Overlay */}
      {error && (
        <div className="netflix-error-overlay">
          <div className="netflix-error-content">
            <div className="netflix-error-icon">⚠️</div>
            <div className="netflix-error-title">Playback Error</div>
            <div className="netflix-error-message">{error}</div>
            <button 
              className="netflix-error-retry"
              onClick={() => {
                setError('');
                if (videoRef.current) {
                  videoRef.current.load();
                }
              }}
            >
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* Skip Intro Button */}
      {showSkipIntro && (
        <div className="netflix-skip-intro">
          <button onClick={skipIntro}>
            Skip Intro
          </button>
        </div>
      )}

      {/* Skip Outro Button */}
      {showSkipOutro && (
        <div className="netflix-skip-outro">
          <button onClick={skipOutro}>
            Skip Outro
          </button>
        </div>
      )}

      {/* Up Next Preview */}
      {showUpNext && playlist.length > 0 && (
        <div className="netflix-up-next">
          <div className="netflix-up-next-content">
            <div className="netflix-up-next-title">Up Next</div>
            <div className="netflix-up-next-item">
              <div className="netflix-up-next-thumbnail">
                {playlist[0].thumbnail_url ? (
                  <img src={playlist[0].thumbnail_url} alt={playlist[0].name} />
                ) : (
                  <div className="netflix-up-next-placeholder">🎬</div>
                )}
              </div>
              <div className="netflix-up-next-info">
                <div className="netflix-up-next-name">{playlist[0].name}</div>
              </div>
            </div>
            <button 
              className="netflix-up-next-play"
              onClick={() => onNextVideo && onNextVideo(playlist[0])}
            >
              ▶ Play
            </button>
          </div>
        </div>
      )}

      {/* Autoplay Countdown */}
      {autoplayCountdown && (
        <div className="netflix-autoplay-countdown">
          <div className="netflix-autoplay-content">
            <div className="netflix-autoplay-title">Playing next episode in {autoplayCountdown}s</div>
            <button className="netflix-autoplay-cancel" onClick={cancelAutoplay}>
              Cancel
            </button>
          </div>
          <div className="netflix-autoplay-progress">
            <div 
              className="netflix-autoplay-progress-bar"
              style={{ width: `${((15 - autoplayCountdown) / 15) * 100}%` }}
            ></div>
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <div className={`netflix-controls ${showControls ? 'visible' : 'hidden'}`}>
        {/* Top Bar */}
        <div className="netflix-top-bar">
          <button className="netflix-back-button" onClick={onBack}>
            ← Back
          </button>
          <div className="netflix-video-title">{video.name}</div>
          <div className="netflix-top-controls">
            <button 
              className="netflix-control-button"
              onClick={() => setShowSettingsMenu(!showSettingsMenu)}
            >
              ⚙️
            </button>
          </div>
        </div>

        {/* Main Play Button Overlay */}
        {!isPlaying && !isBuffering && (
          <div className="netflix-play-overlay">
            <button className="netflix-main-play-button" onClick={togglePlay}>
              ▶
            </button>
          </div>
        )}

        {/* Progress Bar */}
        <div className="netflix-bottom-section">
          <div className="netflix-progress-container">
            <div 
              className="netflix-progress-bar"
              ref={progressBarRef}
              onClick={handleSeek}
              onMouseMove={handleProgressHover}
              onMouseLeave={() => setPreviewTime(null)}
            >
              {/* Buffered ranges */}
              {bufferedRanges.map((range, index) => (
                <div
                  key={index}
                  className="netflix-buffered-range"
                  style={{
                    left: `${(range.start / duration) * 100}%`,
                    width: `${((range.end - range.start) / duration) * 100}%`
                  }}
                />
              ))}
              
              {/* Progress fill */}
              <div 
                className="netflix-progress-fill"
                style={{ width: `${(currentTime / duration) * 100}%` }}
              />
              
              {/* Progress handle */}
              <div 
                className="netflix-progress-handle"
                style={{ left: `${(currentTime / duration) * 100}%` }}
              />
              
              {/* Preview thumbnail */}
              {previewTime && (
                <div 
                  className="netflix-preview-thumbnail"
                  style={{ left: `${(previewTime / duration) * 100}%` }}
                >
                  <div className="netflix-preview-time">
                    {formatTime(previewTime)}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bottom Controls */}
          <div className="netflix-bottom-controls">
            <div className="netflix-left-controls">
              <button className="netflix-control-button netflix-play-pause" onClick={togglePlay}>
                {isPlaying ? '⏸️' : '▶️'}
              </button>
              
              <button className="netflix-control-button" onClick={() => skipTime(-10)}>
                ⏪
              </button>
              
              <button className="netflix-control-button" onClick={() => skipTime(10)}>
                ⏩
              </button>
              
              <div 
                className="netflix-volume-container"
                onMouseEnter={() => setShowVolumeSlider(true)}
                onMouseLeave={() => setShowVolumeSlider(false)}
              >
                <button className="netflix-control-button" onClick={toggleMute}>
                  {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
                </button>
                
                {showVolumeSlider && (
                  <div className="netflix-volume-slider">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={isMuted ? 0 : volume}
                      onChange={(e) => {
                        const newVolume = parseFloat(e.target.value);
                        setVolume(newVolume);
                        setIsMuted(newVolume === 0);
                        if (videoRef.current) {
                          videoRef.current.volume = newVolume;
                        }
                      }}
                    />
                  </div>
                )}
              </div>
              
              <div className="netflix-time-display">
                {formatTime(currentTime)} / {formatTime(duration)}
              </div>
            </div>

            <div className="netflix-right-controls">
              {subtitles.length > 0 && (
                <button 
                  className="netflix-control-button"
                  onClick={() => setShowSubtitleMenu(!showSubtitleMenu)}
                >
                  📝
                </button>
              )}
              
              <button 
                className="netflix-control-button"
                onClick={() => setShowQualityMenu(!showQualityMenu)}
              >
                HD
              </button>
              
              {document.pictureInPictureEnabled && (
                <button className="netflix-control-button" onClick={togglePictureInPicture}>
                  📺
                </button>
              )}
              
              <button className="netflix-control-button" onClick={toggleFullscreen}>
                {isFullscreen ? '🗗' : '⛶'}
              </button>
            </div>
          </div>
        </div>

        {/* Quality Menu */}
        {showQualityMenu && (
          <div className="netflix-menu netflix-quality-menu">
            <div className="netflix-menu-header">Video Quality</div>
            {qualityOptions.map(quality => (
              <div 
                key={quality}
                className={`netflix-menu-item ${currentQuality === quality ? 'active' : ''}`}
                onClick={() => changeQuality(quality)}
              >
                {quality}
                {quality === 'Auto' && <span className="netflix-menu-description">Adjust automatically</span>}
              </div>
            ))}
          </div>
        )}

        {/* Subtitle Menu */}
        {showSubtitleMenu && (
          <div className="netflix-menu netflix-subtitle-menu">
            <div className="netflix-menu-header">Subtitles & Captions</div>
            <div 
              className={`netflix-menu-item ${!currentSubtitle ? 'active' : ''}`}
              onClick={() => selectSubtitle(null)}
            >
              Off
            </div>
            {subtitles.map(subtitle => (
              <div 
                key={subtitle.id}
                className={`netflix-menu-item ${currentSubtitle?.id === subtitle.id ? 'active' : ''}`}
                onClick={() => selectSubtitle(subtitle)}
              >
                {subtitle.name}
                <span className="netflix-menu-description">{subtitle.language}</span>
              </div>
            ))}
          </div>
        )}

        {/* Settings Menu */}
        {showSettingsMenu && (
          <div className="netflix-menu netflix-settings-menu">
            <div className="netflix-menu-header">Playback Settings</div>
            
            <div className="netflix-menu-section">
              <div className="netflix-menu-section-title">Speed</div>
              {playbackRates.map(rate => (
                <div 
                  key={rate}
                  className={`netflix-menu-item ${playbackRate === rate ? 'active' : ''}`}
                  onClick={() => changePlaybackRate(rate)}
                >
                  {rate}x {rate === 1 ? '(Normal)' : ''}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Subtitle Display */}
      {currentSubtitle && (
        <div className="netflix-subtitle-display" style={subtitleStyle}>
          {/* Subtitle text would be displayed here based on current time */}
        </div>
      )}

      {/* Video Info Panel */}
      {!isFullscreen && (
        <div className="netflix-info-panel">
          <div className="netflix-info-title">{video.name}</div>
          {video.folder_path && (
            <div className="netflix-info-path">📁 {video.folder_path}</div>
          )}
          <div className="netflix-info-details">
            <span>Size: {formatFileSize(video.size)}</span>
            <span>Quality: {currentQuality}</span>
            <span>Speed: {playbackRate}x</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default NetflixVideoPlayer;