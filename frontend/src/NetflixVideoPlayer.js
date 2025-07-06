import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import VideoFormatUtils from './VideoFormatUtils';
import './NetflixVideoPlayer.css';

const NetflixVideoPlayer = ({ video, backendUrl, accessToken, onBack, onNextVideo, playlist = [] }) => {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const progressBarRef = useRef(null);
  const volumeBeforeTimelineSeek = useRef(1);
  const bufferCache = useRef(new Map()); // Buffer cache for performance
  const preloadCache = useRef(new Map()); // Preload cache for faster switching
  
  // Core player state with performance optimizations
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  
  // Enhanced player state for performance
  const [currentQuality, setCurrentQuality] = useState('Auto');
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferedRanges, setBufferedRanges] = useState([]);
  const [bufferHealth, setBufferHealth] = useState(0); // Buffer health percentage
  const [error, setError] = useState('');
  const [isPiPMode, setIsPiPMode] = useState(false);
  const [networkSpeed, setNetworkSpeed] = useState('fast'); // Network speed detection
  
  // UI state with optimizations
  const [showControls, setShowControls] = useState(true);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  
  // Advanced UI state
  const [previewTime, setPreviewTime] = useState(null);
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
  
  // Performance state
  const [adaptiveQuality, setAdaptiveQuality] = useState(true);
  const [prefetchEnabled, setPrefetchEnabled] = useState(true);
  const [bufferSize, setBufferSize] = useState(30); // Buffer ahead in seconds
  
  // Mobile detection with performance optimization
  const [isMobile, setIsMobile] = useState(false);
  
  // Timers
  const hideControlsTimer = useRef(null);
  const autoplayTimer = useRef(null);
  const bufferMonitor = useRef(null);
  const performanceMonitor = useRef(null);
  
  // Quality and playback options optimized for performance
  const qualityOptions = useMemo(() => ['Auto', '1080p', '720p', '480p', '360p'], []);
  const playbackRates = useMemo(() => [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], []);
  
  // Device and format detection with caching
  const deviceInfo = useMemo(() => VideoFormatUtils.getDeviceInfo(), []);
  const formatInfo = useMemo(() => VideoFormatUtils.detectFormat(video.name), [video.name]);
  const compatibilityInfo = useMemo(() => VideoFormatUtils.getCompatibilityWarning(video.name), [video.name]);
  const streamingParams = useMemo(() => VideoFormatUtils.getStreamingParams(video.name, video.size), [video.name, video.size]);
  
  // Device-specific flags
  const isMobileChrome = deviceInfo.isMobileChrome;
  const isMKV = formatInfo.format === 'mkv';
  const isMP4 = formatInfo.format === 'mp4';
  const hasCompatibilityIssues = compatibilityInfo.warnings.length > 0;
  
  // Enhanced video URL generation with caching and optimization
  const getOptimizedVideoUrl = useCallback((videoId, quality = 'Auto', enableCache = true) => {
    const cacheKey = `${videoId}_${quality}`;
    
    if (enableCache && preloadCache.current.has(cacheKey)) {
      return preloadCache.current.get(cacheKey);
    }
    
    let baseUrl = `${backendUrl}/api/stream/${videoId}?token=${accessToken}`;
    
    // Add performance parameters based on format and device
    const params = new URLSearchParams();
    
    // Quality parameter
    if (quality !== 'Auto') {
      params.append('quality', quality.toLowerCase());
    }
    
    // Device-specific optimizations
    if (isMobileChrome && isMKV) {
      params.append('mobile_mkv', 'true');
      params.append('chunk_size', '32768'); // 32KB chunks for mobile MKV
    } else if (isMKV) {
      params.append('chunk_size', '65536'); // 64KB chunks for desktop MKV
    } else if (video.size > 500 * 1024 * 1024) { // Files > 500MB
      params.append('chunk_size', '1048576'); // 1MB chunks for large files
    }
    
    // Buffer optimization
    params.append('buffer_size', bufferSize.toString());
    
    // Network speed optimization
    if (networkSpeed === 'slow') {
      params.append('low_bandwidth', 'true');
    }
    
    // Add cache busting for error recovery
    if (!enableCache) {
      params.append('t', Date.now().toString());
    }
    
    const optimizedUrl = `${baseUrl}&${params.toString()}`;
    
    if (enableCache) {
      preloadCache.current.set(cacheKey, optimizedUrl);
    }
    
    return optimizedUrl;
  }, [backendUrl, accessToken, isMobileChrome, isMKV, video.size, bufferSize, networkSpeed]);

  // Network speed detection
  useEffect(() => {
    const detectNetworkSpeed = async () => {
      try {
        const startTime = Date.now();
        // Test with a small chunk request
        const testUrl = `${backendUrl}/api/stream/${video.id}?token=${accessToken}&test=true`;
        const response = await fetch(testUrl, {
          method: 'HEAD',
          headers: { 'Range': 'bytes=0-1023' } // 1KB test
        });
        
        const endTime = Date.now();
        const latency = endTime - startTime;
        
        if (latency > 2000) {
          setNetworkSpeed('slow');
          setBufferSize(60); // Increase buffer for slow networks
        } else if (latency > 1000) {
          setNetworkSpeed('medium');
          setBufferSize(45);
        } else {
          setNetworkSpeed('fast');
          setBufferSize(30);
        }
      } catch (error) {
        console.warn('Network speed detection failed:', error);
        setNetworkSpeed('medium');
      }
    };
    
    detectNetworkSpeed();
  }, [backendUrl, video.id, accessToken]);

  // Log format information for debugging
  useEffect(() => {
    VideoFormatUtils.logFormatInfo(video.name, video.size);
  }, [video.name, video.size]);

  // Initialize player with performance optimizations
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
    
    // Start performance monitoring
    startPerformanceMonitoring();
    
    return () => {
      window.removeEventListener('resize', checkMobile);
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
      if (autoplayTimer.current) clearTimeout(autoplayTimer.current);
      if (bufferMonitor.current) clearInterval(bufferMonitor.current);
      if (performanceMonitor.current) clearInterval(performanceMonitor.current);
    };
  }, []);

  // Enhanced video event handlers with performance optimizations
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleLoadedMetadata = () => {
      setDuration(videoElement.duration);
      setError('');
      showControlsTemporarily();
      
      // Detect intro/outro sections with performance consideration
      if (videoElement.duration > 60) {
        setShowSkipIntro(true);
        setTimeout(() => setShowSkipIntro(false), 30000);
      }
      
      // Start buffer monitoring
      startBufferMonitoring();
      
      // Preload next video if available
      if (prefetchEnabled && playlist.length > 0) {
        preloadNextVideo();
      }
    };

    const handleTimeUpdate = useCallback(() => {
      const currentTime = videoElement.currentTime;
      setCurrentTime(currentTime);
      
      // Enhanced buffered ranges tracking
      const buffered = videoElement.buffered;
      const ranges = [];
      let totalBuffered = 0;
      
      for (let i = 0; i < buffered.length; i++) {
        const start = buffered.start(i);
        const end = buffered.end(i);
        ranges.push({ start, end });
        totalBuffered += end - start;
      }
      
      setBufferedRanges(ranges);
      
      // Calculate buffer health
      const bufferAhead = totalBuffered - currentTime;
      const bufferHealthPercent = Math.min(100, (bufferAhead / bufferSize) * 100);
      setBufferHealth(bufferHealthPercent);
      
      // Adaptive quality based on buffer health
      if (adaptiveQuality && bufferHealthPercent < 30 && currentQuality !== '720p') {
        console.log('Auto-reducing quality due to buffer health');
        changeQuality('720p');
      } else if (adaptiveQuality && bufferHealthPercent > 80 && currentQuality !== 'Auto') {
        console.log('Auto-increasing quality due to good buffer health');
        changeQuality('Auto');
      }
      
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
    }, [duration, playlist.length, bufferSize, adaptiveQuality, currentQuality]);

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
      
      if (isMKV) {
        if (isMobileChrome) {
          setError('MKV playback on mobile Chrome may have issues. Trying optimized streaming...');
          // Retry with mobile optimization
          setTimeout(() => {
            videoElement.src = getOptimizedVideoUrl(video.id, currentQuality, false);
            videoElement.load();
          }, 2000);
        } else {
          setError('MKV file format detected. Loading with optimized settings...');
          setTimeout(() => {
            videoElement.src = getOptimizedVideoUrl(video.id, '720p', false);
            videoElement.load();
          }, 2000);
        }
      } else {
        setError('Video playback error. Trying to recover...');
        // Auto-retry with lower quality
        setTimeout(() => {
          const lowerQuality = currentQuality === 'Auto' ? '720p' : '480p';
          videoElement.src = getOptimizedVideoUrl(video.id, lowerQuality, false);
          videoElement.load();
        }, 2000);
      }
    };

    const handleProgress = () => {
      setIsBuffering(false);
      
      // Update buffer cache
      const buffered = videoElement.buffered;
      const cacheKey = `${video.id}_${currentQuality}`;
      const bufferData = [];
      
      for (let i = 0; i < buffered.length; i++) {
        bufferData.push({
          start: buffered.start(i),
          end: buffered.end(i)
        });
      }
      
      bufferCache.current.set(cacheKey, bufferData);
    };

    // Attach event listeners with optimized throttling
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
  }, [video.id, duration, playlist, onNextVideo, currentQuality, getOptimizedVideoUrl, isMKV, isMobileChrome, bufferSize, adaptiveQuality, prefetchEnabled]);

  // Performance monitoring
  const startPerformanceMonitoring = useCallback(() => {
    performanceMonitor.current = setInterval(() => {
      const videoElement = videoRef.current;
      if (!videoElement) return;
      
      // Monitor dropped frames (if supported)
      if (videoElement.getVideoPlaybackQuality) {
        const quality = videoElement.getVideoPlaybackQuality();
        const droppedFrameRatio = quality.droppedVideoFrames / quality.totalVideoFrames;
        
        if (droppedFrameRatio > 0.05 && adaptiveQuality) { // More than 5% dropped frames
          console.log('High dropped frame ratio detected, reducing quality');
          const lowerQuality = currentQuality === 'Auto' ? '720p' : '480p';
          changeQuality(lowerQuality);
        }
      }
      
      // Monitor playback stalls
      if (videoElement.readyState < 3 && isPlaying) {
        console.log('Playback stall detected');
        setIsBuffering(true);
      }
    }, 5000); // Check every 5 seconds
  }, [adaptiveQuality, currentQuality, isPlaying]);

  // Buffer monitoring
  const startBufferMonitoring = useCallback(() => {
    bufferMonitor.current = setInterval(() => {
      const videoElement = videoRef.current;
      if (!videoElement) return;
      
      const buffered = videoElement.buffered;
      const currentTime = videoElement.currentTime;
      let bufferAhead = 0;
      
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= currentTime && buffered.end(i) > currentTime) {
          bufferAhead = buffered.end(i) - currentTime;
          break;
        }
      }
      
      // If buffer is low, pause until we have enough buffer
      if (bufferAhead < 5 && isPlaying && !isBuffering) {
        console.log('Buffer too low, temporarily pausing');
        setIsBuffering(true);
        videoElement.pause();
        
        // Resume when buffer is healthy
        setTimeout(() => {
          if (bufferAhead > 10) {
            setIsBuffering(false);
            videoElement.play();
          }
        }, 2000);
      }
    }, 1000); // Check every second
  }, [isPlaying, isBuffering]);

  // Preload next video for faster switching
  const preloadNextVideo = useCallback(() => {
    if (playlist.length > 0 && prefetchEnabled) {
      const nextVideo = playlist[0];
      const preloadUrl = getOptimizedVideoUrl(nextVideo.id, currentQuality, true);
      
      // Create a hidden video element for preloading
      const preloadVideo = document.createElement('video');
      preloadVideo.src = preloadUrl;
      preloadVideo.preload = 'metadata';
      preloadVideo.style.display = 'none';
      document.body.appendChild(preloadVideo);
      
      // Remove after preloading
      setTimeout(() => {
        document.body.removeChild(preloadVideo);
      }, 10000);
    }
  }, [playlist, prefetchEnabled, currentQuality, getOptimizedVideoUrl]);

  // Keyboard shortcuts with performance optimization
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

  // Player control functions with optimizations
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
      
      // Update video source with optimized URL
      const newSrc = getOptimizedVideoUrl(video.id, quality);
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

  // Control visibility with optimizations
  const showControlsTemporarily = () => {
    setShowControls(true);
    
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    
    hideControlsTimer.current = setTimeout(() => {
      if (isPlaying && isFullscreen && !showQualityMenu && !showSubtitleMenu && !showSettingsMenu) {
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
    
    setShowControls(true);
    showControlsTemporarily();
  };

  const handleContainerClick = (e) => {
    if (!isMobile) return;
    
    setShowControls(true);
    showControlsTemporarily();
    
    if (e.target === videoRef.current) {
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

  const getBufferHealthColor = () => {
    if (bufferHealth > 70) return '#4CAF50'; // Green
    if (bufferHealth > 30) return '#FF9800'; // Orange
    return '#F44336'; // Red
  };

  return (
    <div 
      className={`netflix-player-container ${isFullscreen ? 'fullscreen' : ''}`}
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => !isMobile && isPlaying && isFullscreen && setShowControls(false)}
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

      {/* Video Element with enhanced attributes for performance */}
      <video
        ref={videoRef}
        className="netflix-video"
        src={getOptimizedVideoUrl(video.id, currentQuality)}
        preload="metadata"
        crossOrigin="anonymous"
        playsInline
        autoPlay={false}
        muted={false}
        controls={false}
        {...(isMKV ? {
          'webkit-playsinline': true,
          'x5-playsinline': true,
          'x5-video-player-type': 'h5'
        } : {})}
        onClick={!isMobile ? togglePlay : undefined}
      />

      {/* Enhanced Loading Overlay with buffer info */}
      {isBuffering && (
        <div className="netflix-loading-overlay">
          <div className="netflix-spinner">
            <div className="netflix-spinner-circle"></div>
          </div>
          <div className="netflix-loading-text">
            {isMP4 ? 'Loading MP4...' : isMKV ? 'Loading MKV...' : 'Loading...'}
          </div>
          <div className="netflix-buffer-info">
            Buffer: {Math.round(bufferHealth)}%
          </div>
          {networkSpeed !== 'fast' && (
            <div className="netflix-network-info">
              Network: {networkSpeed}
            </div>
          )}
        </div>
      )}

      {/* Enhanced Error Overlay with format-specific help */}
      {error && (
        <div className="netflix-error-overlay">
          <div className="netflix-error-content">
            <div className="netflix-error-icon">⚠️</div>
            <div className="netflix-error-title">Playback Error</div>
            <div className="netflix-error-message">{error}</div>
            {isMKV && (
              <div className="netflix-format-help">
                <p><strong>MKV Optimization Tips:</strong></p>
                <p>• Using optimized chunking for better performance</p>
                <p>• {isMobileChrome ? 'Mobile Chrome mode enabled' : 'Desktop optimization active'}</p>
              </div>
            )}
            <button 
              className="netflix-error-retry"
              onClick={() => {
                setError('');
                if (videoRef.current) {
                  videoRef.current.src = getOptimizedVideoUrl(video.id, currentQuality, false);
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
        {/* Top Bar with performance info */}
        <div className="netflix-top-bar">
          <button className="netflix-back-button" onClick={onBack}>
            ← Back
          </button>
          <div className="netflix-video-title">{video.name}</div>
          <div className="netflix-top-controls">
            {/* Buffer health indicator */}
            <div className="netflix-buffer-indicator">
              <div 
                className="netflix-buffer-bar"
                style={{ 
                  width: `${bufferHealth}%`,
                  backgroundColor: getBufferHealthColor()
                }}
              ></div>
            </div>
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

        {/* Progress Bar with enhanced buffering visualization */}
        <div className="netflix-bottom-section">
          <div className="netflix-progress-container">
            <div 
              className="netflix-progress-bar"
              ref={progressBarRef}
              onClick={handleSeek}
              onMouseMove={handleProgressHover}
              onMouseLeave={() => setPreviewTime(null)}
            >
              {/* Enhanced buffered ranges */}
              {bufferedRanges.map((range, index) => (
                <div
                  key={index}
                  className="netflix-buffered-range"
                  style={{
                    left: `${(range.start / duration) * 100}%`,
                    width: `${((range.end - range.start) / duration) * 100}%`,
                    opacity: 0.6
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
                {currentQuality === 'Auto' ? 'HD' : currentQuality}
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

        {/* Enhanced Quality Menu */}
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
                {quality === 'Auto' && <span className="netflix-menu-description">Adaptive quality</span>}
                {quality === '1080p' && <span className="netflix-menu-description">Full HD</span>}
                {quality === '720p' && <span className="netflix-menu-description">HD</span>}
              </div>
            ))}
            <div className="netflix-menu-divider"></div>
            <div 
              className={`netflix-menu-item ${adaptiveQuality ? 'active' : ''}`}
              onClick={() => setAdaptiveQuality(!adaptiveQuality)}
            >
              Adaptive Quality
              <span className="netflix-menu-description">Auto-adjust based on performance</span>
            </div>
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

        {/* Enhanced Settings Menu */}
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
            
            <div className="netflix-menu-section">
              <div className="netflix-menu-section-title">Performance</div>
              <div 
                className={`netflix-menu-item ${prefetchEnabled ? 'active' : ''}`}
                onClick={() => setPrefetchEnabled(!prefetchEnabled)}
              >
                Preload Next Video
                <span className="netflix-menu-description">Faster switching</span>
              </div>
              <div className="netflix-menu-item">
                Buffer Size: {bufferSize}s
                <span className="netflix-menu-description">Network: {networkSpeed}</span>
              </div>
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

      {/* Enhanced Video Info Panel */}
      {!isFullscreen && (
        <div className="netflix-info-panel">
          <div className="netflix-info-title">{video.name}</div>
          {video.folder_path && (
            <div className="netflix-info-path">📁 {video.folder_path}</div>
          )}
          <div className="netflix-info-details">
            <span>Size: {formatFileSize(video.size)}</span>
            <span>Format: {formatInfo.format.toUpperCase()}</span>
            <span>Quality: {currentQuality}</span>
            <span>Speed: {playbackRate}x</span>
            <span>Buffer: {Math.round(bufferHealth)}%</span>
            <span>Network: {networkSpeed}</span>
          </div>
          {hasCompatibilityIssues && (
            <div className="netflix-compatibility-warning">
              ⚠️ {compatibilityInfo.compatibility} compatibility - {compatibilityInfo.warnings[0]}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default NetflixVideoPlayer;