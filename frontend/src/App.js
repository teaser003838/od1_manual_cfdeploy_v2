import React, { useState, useEffect, useRef } from 'react';
import NetflixVideoPlayer from './NetflixVideoPlayer';
import AudioPlayer from './AudioPlayer';
import FileExplorer from './FileExplorer';
import PhotoSlideshow from './PhotoSlideshow';
import './App.css';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8001');

function App() {
  const [isOneDriveAuthenticated, setIsOneDriveAuthenticated] = useState(false);
  const [accessToken, setAccessToken] = useState(null);
  const [currentView, setCurrentView] = useState('explorer'); // 'explorer', 'video', 'audio', 'photo'
  const [selectedItem, setSelectedItem] = useState(null);
  const [currentFolder, setCurrentFolder] = useState('root'); // Track current folder for navigation
  const [allPhotos, setAllPhotos] = useState([]);
  const [videoPlaylist, setVideoPlaylist] = useState([]); // For Netflix-style next video functionality
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSearch, setShowSearch] = useState(false); // For mobile search toggle
  const [showFilters, setShowFilters] = useState(false); // For filters dropdown
  const [showScrollToTop, setShowScrollToTop] = useState(false); // For scroll to top button
  
  // Navigation history management
  const [navigationHistory, setNavigationHistory] = useState([]);
  const isNavigatingBack = useRef(false);

  useEffect(() => {
    // Check for existing OneDrive access token
    const savedAccessToken = localStorage.getItem('access_token');
    
    if (savedAccessToken) {
      setAccessToken(savedAccessToken);
      setIsOneDriveAuthenticated(true);
    }
    
    // Set website title
    document.title = 'OneFlex | Fast Smooth Free Streaming';
  }, []);

  // Handle OAuth callback
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const accessTokenFromUrl = urlParams.get('access_token');
    const authError = urlParams.get('error');
    
    if (authError) {
      console.error('Authentication error:', authError);
      setError('OneDrive authentication failed. Please try again.');
      return;
    }
    
    if (accessTokenFromUrl && !isOneDriveAuthenticated) {
      localStorage.setItem('access_token', accessTokenFromUrl);
      setAccessToken(accessTokenFromUrl);
      setIsOneDriveAuthenticated(true);
      
      // Clear URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [isOneDriveAuthenticated]);

  // Handle scroll to show/hide scroll-to-top button
  useEffect(() => {
    const handleScroll = () => {
      setShowScrollToTop(window.scrollY > 300);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Browser history management for back button support
  useEffect(() => {
    const handlePopState = (event) => {
      if (event.state) {
        isNavigatingBack.current = true;
        const { view, folder, item } = event.state;
        
        // Restore the state from browser history
        setCurrentView(view);
        setCurrentFolder(folder);
        
        if (item) {
          setSelectedItem(item);
        } else {
          setSelectedItem(null);
          setAllPhotos([]);
          setVideoPlaylist([]);
        }
        
        setShowSearch(false);
        
        // Reset navigation flag after state update
        setTimeout(() => {
          isNavigatingBack.current = false;
        }, 100);
      }
    };

    window.addEventListener('popstate', handlePopState);
    
    // Set initial state
    if (isOneDriveAuthenticated && currentView === 'explorer') {
      const initialState = {
        view: 'explorer',
        folder: currentFolder,
        item: null
      };
      window.history.replaceState(initialState, '', window.location.pathname);
    }

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isOneDriveAuthenticated, currentView, currentFolder]);

  // Push state to history when navigation occurs
  const pushHistoryState = (view, folder, item = null) => {
    if (isNavigatingBack.current) return; // Don't push state during back navigation
    
    const state = { view, folder, item };
    const url = window.location.pathname;
    
    // Update navigation history for internal tracking
    setNavigationHistory(prev => [...prev, { view, folder, item, timestamp: Date.now() }]);
    
    // Push to browser history
    window.history.pushState(state, '', url);
  };

  const handleOneDriveLogin = async () => {
    try {
      console.log('Attempting to login with backend URL:', BACKEND_URL);
      const response = await fetch(`${BACKEND_URL}/api/auth/login`);
      console.log('Response status:', response.status);
      console.log('Response headers:', response.headers);
      
      // Check if response is ok before parsing
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Response not ok:', response.status, errorText);
        setError(`Login failed with status ${response.status}: ${errorText}`);
        return;
      }
      
      // Check content type
      const contentType = response.headers.get('content-type');
      console.log('Content-Type:', contentType);
      
      if (!contentType || !contentType.includes('application/json')) {
        const responseText = await response.text();
        console.error('Response is not JSON:', responseText);
        setError('Server returned non-JSON response. Please try again.');
        return;
      }
      
      const data = await response.json();
      console.log('Login response data:', data);
      
      if (data.auth_url) {
        window.location.href = data.auth_url;
      } else {
        setError('No auth URL received from server.');
      }
    } catch (error) {
      console.error('OneDrive login failed:', error);
      console.error('Error type:', error.constructor.name);
      console.error('Error message:', error.message);
      setError(`OneDrive login failed: ${error.message}`);
    }
  };

  const handlePlayVideo = async (video) => {
    setSelectedItem(video);
    
    // Build playlist for Netflix-style auto-play next functionality
    try {
      // Get all videos from current folder for playlist
      const response = await fetch(`${BACKEND_URL}/api/explorer/browse?folder_id=${currentFolder}&file_types=video&page_size=1000`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        const allVideos = data.files || [];
        
        // Create playlist excluding current video
        const playlist = allVideos.filter(v => v.id !== video.id);
        setVideoPlaylist(playlist);
      }
    } catch (error) {
      console.error('Failed to build video playlist:', error);
      setVideoPlaylist([]);
    }
    
    setCurrentView('video');
    
    // Push state to browser history
    pushHistoryState('video', currentFolder, video);
  };

  const handleNextVideo = (nextVideo) => {
    if (nextVideo) {
      setSelectedItem(nextVideo);
      
      // Update playlist to remove the video we just played
      const updatedPlaylist = videoPlaylist.filter(v => v.id !== nextVideo.id);
      setVideoPlaylist(updatedPlaylist);
    }
  };

  const handlePlayAudio = (audio) => {
    setSelectedItem(audio);
    setCurrentView('audio');
    
    // Push state to browser history
    pushHistoryState('audio', currentFolder, audio);
  };

  const handleViewPhoto = async (photo) => {
    setSelectedItem(photo);
    
    // Get all photos from the current folder for slideshow
    // This is a simplified version - in a real app, you'd get this from the file explorer
    setAllPhotos([photo]); // For now, just the single photo
    
    setCurrentView('photo');
    
    // Push state to browser history
    pushHistoryState('photo', currentFolder, photo);
  };

  const handleFolderChange = (folderId) => {
    setCurrentFolder(folderId);
    
    // Push state to browser history for folder navigation
    pushHistoryState('explorer', folderId, null);
  };

  const handleBackToExplorer = () => {
    // Instead of directly setting state, use browser back functionality
    if (window.history.length > 1) {
      window.history.back();
    } else {
      // Fallback if no history available
      setCurrentView('explorer');
      setSelectedItem(null);
      setAllPhotos([]);
      setVideoPlaylist([]);
      setShowSearch(false);
      pushHistoryState('explorer', currentFolder, null);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('access_token');
    setIsOneDriveAuthenticated(false);
    setAccessToken(null);
    setSelectedItem(null);
    setCurrentView('explorer');
    setError('');
    setShowSearch(false);
  };

  const toggleSearch = () => {
    setShowSearch(!showSearch);
  };

  const toggleFilters = () => {
    setShowFilters(!showFilters);
  };

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  };

  // OneDrive Authentication Screen
  if (!isOneDriveAuthenticated) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h1>OneFlex | Fast Smooth Free Streaming</h1>
          <p>Connect to your OneDrive to explore files</p>
          
          {error && (
            <div className="error-message">
              ⚠️ {error}
            </div>
          )}
          
          <button onClick={handleOneDriveLogin} className="login-button">
            Sign in with Microsoft OneDrive
          </button>
        </div>
      </div>
    );
  }

  // Netflix Video Player View
  if (currentView === 'video' && selectedItem) {
    return (
      <NetflixVideoPlayer 
        video={selectedItem}
        backendUrl={BACKEND_URL}
        accessToken={accessToken}
        onBack={handleBackToExplorer}
        onNextVideo={handleNextVideo}
        playlist={videoPlaylist}
      />
    );
  }

  // Audio Player View
  if (currentView === 'audio' && selectedItem) {
    return (
      <AudioPlayer 
        audio={selectedItem}
        backendUrl={BACKEND_URL}
        accessToken={accessToken}
        onBack={handleBackToExplorer}
      />
    );
  }

  // Photo Slideshow View
  if (currentView === 'photo' && selectedItem) {
    return (
      <PhotoSlideshow 
        photo={selectedItem}
        accessToken={accessToken}
        onBack={handleBackToExplorer}
        allPhotos={allPhotos}
      />
    );
  }

  // Main File Explorer View
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1>OneFlex | Fast Smooth Free Streaming</h1>
          <div className="header-actions">
            <button 
              onClick={toggleSearch} 
              className="search-toggle-button"
              title="Search"
            >
              🔍
            </button>
            <button 
              onClick={handleLogout} 
              className="logout-button"
              title="Logout"
            >
              🚪
            </button>
            <button 
              onClick={toggleFilters} 
              className="filters-button"
              title="Filters"
            >
              🎛️
            </button>
          </div>
        </div>
      </header>

      <main className="main-content">
        <FileExplorer
          accessToken={accessToken}
          currentFolder={currentFolder}
          onFolderChange={handleFolderChange}
          onPlayVideo={handlePlayVideo}
          onPlayAudio={handlePlayAudio}
          onViewPhoto={handleViewPhoto}
          showSearch={showSearch}
          onSearchToggle={toggleSearch}
          showFilters={showFilters}
          onFiltersToggle={toggleFilters}
        />
      </main>

      {/* Scroll to Top Button */}
      {showScrollToTop && (
        <button
          onClick={scrollToTop}
          className="scroll-to-top-button"
          title="Scroll to top"
          aria-label="Scroll to top"
        >
          ⬆️
        </button>
      )}
    </div>
  );
}

export default App;