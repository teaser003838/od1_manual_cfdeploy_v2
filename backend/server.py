from fastapi import FastAPI, Request, HTTPException, Header, Depends, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, RedirectResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel
from msal import ConfidentialClientApplication
import httpx
import os
from datetime import datetime
from typing import Optional, List, Dict, Any
import json
import asyncio
import logging
import hashlib
import secrets

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OneDrive File Explorer API", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Environment variables
CLIENT_ID = os.getenv("AZURE_CLIENT_ID", "37fb551b-33c1-4dd0-8c16-5ead6f0f2b45")
CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET", "_IW8Q~l-15ff~RpMif-PfScDyFbV9rn92Hx5Laz5")
TENANT_ID = os.getenv("AZURE_TENANT_ID", "f2c9e08f-779f-4dd6-9f7b-da627fd90983")
MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")
REDIRECT_URI = os.getenv("REDIRECT_URI", "https://onedrive-media-api.hul1hu.workers.dev/api/auth/callback")

# MSAL Configuration
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
SCOPES = ["Files.ReadWrite.All", "User.Read", "offline_access"]

msal_app = ConfidentialClientApplication(
    client_id=CLIENT_ID,
    client_credential=CLIENT_SECRET,
    authority=AUTHORITY
)

# Models
class WatchHistory(BaseModel):
    item_id: str
    name: str
    timestamp: Optional[datetime] = None

class UserPreferences(BaseModel):
    theme: str = "dark"
    quality: str = "auto"

class FileItem(BaseModel):
    id: str
    name: str
    type: str  # 'file' or 'folder'
    size: Optional[int] = None
    modified: Optional[datetime] = None
    created: Optional[datetime] = None
    mime_type: Optional[str] = None
    parent_path: Optional[str] = None
    full_path: str
    is_media: bool = False
    media_type: Optional[str] = None  # 'video', 'photo', 'other'
    thumbnail_url: Optional[str] = None
    download_url: Optional[str] = None

class FolderContents(BaseModel):
    current_folder: str
    parent_folder: Optional[str] = None
    breadcrumbs: List[Dict[str, str]] = []
    folders: List[FileItem] = []
    files: List[FileItem] = []
    total_size: int = 0
    folder_count: int = 0
    file_count: int = 0
    media_count: int = 0

# Database connection
@app.on_event("startup")
async def startup_event():
    app.mongodb_client = AsyncIOMotorClient(MONGO_URL)
    app.mongodb = app.mongodb_client["onedrive_netflix"]
    logger.info("Connected to MongoDB")

@app.on_event("shutdown")
async def shutdown_event():
    app.mongodb_client.close()

# Authentication endpoints
@app.get("/api/auth/login")
async def login():
    try:
        # Use minimal scopes to avoid the frozenset issue
        scopes_list = ["Files.ReadWrite.All", "User.Read"]
        logger.info(f"Using scopes: {scopes_list}")
        logger.info(f"Using redirect URI: {REDIRECT_URI}")
        logger.info(f"Using authority: {AUTHORITY}")
        
        auth_url = msal_app.get_authorization_request_url(
            scopes=scopes_list,
            redirect_uri=REDIRECT_URI
        )
        
        logger.info(f"Generated auth URL: {auth_url}")
        return {"auth_url": auth_url}
    except Exception as e:
        logger.error(f"Login error: {str(e)}")
        logger.error(f"Exception type: {type(e)}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail="Authentication failed")

@app.get("/api/auth/callback")
async def auth_callback(code: str, state: Optional[str] = None):
    try:
        result = msal_app.acquire_token_by_authorization_code(
            code=code,
            scopes=["Files.ReadWrite.All", "User.Read"],
            redirect_uri=REDIRECT_URI
        )
        
        if "access_token" not in result:
            logger.error(f"Token acquisition failed: {result}")
            # Redirect to frontend with error
            frontend_url = os.getenv("FRONTEND_URL", "https://onedrive-media-app.pages.dev")
            return RedirectResponse(url=f"{frontend_url}?error=authentication_failed")
        
        # Store user info in database
        user_info = await get_user_info(result["access_token"])
        user_id = user_info.get("id")
        
        if user_id:
            await app.mongodb["users"].update_one(
                {"user_id": user_id},
                {
                    "$set": {
                        "user_id": user_id,
                        "name": user_info.get("displayName"),
                        "email": user_info.get("mail", user_info.get("userPrincipalName")),
                        "last_login": datetime.utcnow()
                    }
                },
                upsert=True
            )
        
        # Redirect to frontend with access token
        frontend_url = os.getenv("FRONTEND_URL", "https://onedrive-media-app.pages.dev")
        return RedirectResponse(url=f"{frontend_url}?access_token={result['access_token']}")
        
    except Exception as e:
        logger.error(f"Callback error: {str(e)}")
        frontend_url = os.getenv("FRONTEND_URL", "https://onedrive-media-app.pages.dev")
        return RedirectResponse(url=f"{frontend_url}?error=callback_failed")

async def get_user_info(access_token: str):
    async with httpx.AsyncClient() as client:
        response = await client.get(
            "https://graph.microsoft.com/v1.0/me",
            headers={"Authorization": f"Bearer {access_token}"}
        )
        if response.status_code == 200:
            return response.json()
        return {}

@app.get("/api/explorer/batch-browse")
async def batch_browse_folders(
    folder_ids: str,  # Comma-separated folder IDs
    max_items_per_folder: int = 50,
    authorization: str = Header(...)
):
    """Batch browse multiple folders for performance optimization"""
    try:
        access_token = authorization.replace("Bearer ", "")
        folder_id_list = [fid.strip() for fid in folder_ids.split(",") if fid.strip()]
        
        if not folder_id_list:
            raise HTTPException(status_code=400, detail="No folder IDs provided")
        
        if len(folder_id_list) > 20:  # Limit batch size
            raise HTTPException(status_code=400, detail="Too many folders requested (max 20)")
        
        max_items_per_folder = min(max_items_per_folder, 200)  # Limit items per folder
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            # Create concurrent tasks for each folder
            tasks = []
            for folder_id in folder_id_list:
                task = asyncio.create_task(
                    batch_browse_single_folder(client, access_token, folder_id, max_items_per_folder)
                )
                tasks.append((folder_id, task))
            
            # Execute all requests concurrently
            results = {}
            for folder_id, task in tasks:
                try:
                    result = await task
                    results[folder_id] = result
                except Exception as e:
                    logger.error(f"Error browsing folder {folder_id}: {str(e)}")
                    results[folder_id] = {
                        "error": str(e),
                        "folders": [],
                        "files": [],
                        "total_items": 0
                    }
            
            return {"results": results}
            
    except Exception as e:
        logger.error(f"Batch browse error: {str(e)}")
        raise HTTPException(status_code=500, detail="Batch browse failed")

async def batch_browse_single_folder(
    client: httpx.AsyncClient, 
    access_token: str, 
    folder_id: str, 
    max_items: int
) -> dict:
    """Browse a single folder for batch operation"""
    try:
        # Get folder contents
        if folder_id == "root":
            url = "https://graph.microsoft.com/v1.0/me/drive/root/children"
        else:
            url = f"https://graph.microsoft.com/v1.0/me/drive/items/{folder_id}/children"
        
        url += f"?$top={max_items}"
        
        response = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
        
        if response.status_code != 200:
            return {
                "error": f"Failed to fetch folder: {response.status_code}",
                "folders": [],
                "files": [],
                "total_items": 0
            }
        
        data = response.json()
        items = data.get("value", [])
        
        # Quick processing for batch operation
        folders = []
        files = []
        
        for item in items:
            if item.get("folder"):
                folders.append({
                    "id": item["id"],
                    "name": item["name"],
                    "type": "folder",
                    "size": item.get("size", 0),
                    "modified": item.get("lastModifiedDateTime")
                })
            else:
                # Quick media type detection
                item_name = item.get("name", "").lower()
                mime_type = item.get("file", {}).get("mimeType", "")
                
                media_type = "other"
                if any(ext in item_name for ext in ['.mp4', '.mkv', '.avi', '.webm']) or 'video' in mime_type:
                    media_type = "video"
                elif any(ext in item_name for ext in ['.jpg', '.jpeg', '.png', '.gif']) or 'image' in mime_type:
                    media_type = "photo"
                elif any(ext in item_name for ext in ['.mp3', '.wav', '.flac', '.m4a']) or 'audio' in mime_type:
                    media_type = "audio"
                
                files.append({
                    "id": item["id"],
                    "name": item["name"],
                    "type": "file",
                    "size": item.get("size", 0),
                    "modified": item.get("lastModifiedDateTime"),
                    "media_type": media_type,
                    "mime_type": mime_type
                })
        
        return {
            "folders": folders,
            "files": files,
            "total_items": len(items),
            "has_more": len(items) == max_items  # Indicates if there might be more items
        }
        
    except Exception as e:
        return {
            "error": str(e),
            "folders": [],
            "files": [],
            "total_items": 0
        }

@app.get("/api/explorer/quick-stats")
async def get_folder_quick_stats(
    folder_ids: str,  # Comma-separated folder IDs
    authorization: str = Header(...)
):
    """Get quick statistics for multiple folders without full content"""
    try:
        access_token = authorization.replace("Bearer ", "")
        folder_id_list = [fid.strip() for fid in folder_ids.split(",") if fid.strip()]
        
        if not folder_id_list:
            raise HTTPException(status_code=400, detail="No folder IDs provided")
        
        if len(folder_id_list) > 50:  # Allow more folders for stats
            raise HTTPException(status_code=400, detail="Too many folders requested (max 50)")
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Create concurrent tasks for each folder
            tasks = []
            for folder_id in folder_id_list:
                task = asyncio.create_task(
                    get_single_folder_stats(client, access_token, folder_id)
                )
                tasks.append((folder_id, task))
            
            # Execute all requests concurrently
            results = {}
            for folder_id, task in tasks:
                try:
                    result = await task
                    results[folder_id] = result
                except Exception as e:
                    logger.error(f"Error getting stats for folder {folder_id}: {str(e)}")
                    results[folder_id] = {
                        "error": str(e),
                        "total_items": 0,
                        "folder_count": 0,
                        "file_count": 0,
                        "total_size": 0
                    }
            
            return {"results": results}
            
    except Exception as e:
        logger.error(f"Quick stats error: {str(e)}")
        raise HTTPException(status_code=500, detail="Quick stats failed")

async def get_single_folder_stats(client: httpx.AsyncClient, access_token: str, folder_id: str) -> dict:
    """Get quick stats for a single folder"""
    try:
        # Get folder contents with minimal data
        if folder_id == "root":
            url = "https://graph.microsoft.com/v1.0/me/drive/root/children?$select=id,name,size,folder&$top=1000"
        else:
            url = f"https://graph.microsoft.com/v1.0/me/drive/items/{folder_id}/children?$select=id,name,size,folder&$top=1000"
        
        response = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
        
        if response.status_code != 200:
            return {
                "error": f"Failed to fetch folder: {response.status_code}",
                "total_items": 0,
                "folder_count": 0,
                "file_count": 0,
                "total_size": 0
            }
        
        data = response.json()
        items = data.get("value", [])
        
        # Calculate quick stats
        folder_count = 0
        file_count = 0
        total_size = 0
        
        for item in items:
            size = item.get("size", 0)
            total_size += size
            
            if item.get("folder"):
                folder_count += 1
            else:
                file_count += 1
        
        return {
            "total_items": len(items),
            "folder_count": folder_count,
            "file_count": file_count,
            "total_size": total_size,
            "has_more": len(items) == 1000  # Indicates if there might be more items
        }
        
    except Exception as e:
        return {
            "error": str(e),
            "total_items": 0,
            "folder_count": 0,
            "file_count": 0,
            "total_size": 0
        }

# File explorer endpoints with performance optimizations
@app.get("/api/explorer/browse")
async def browse_folder(
    folder_id: str = "root", 
    page: int = 1, 
    page_size: int = 100,
    sort_by: str = "name",
    sort_order: str = "asc",
    file_types: str = "all",  # all, video, audio, photo, folder
    authorization: str = Header(...)
):
    """Browse OneDrive folder with pagination and performance optimizations"""
    try:
        access_token = authorization.replace("Bearer ", "")
        
        # Validate pagination parameters
        page = max(1, page)
        page_size = min(max(1, page_size), 1000)  # Limit to 1000 items per page
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Get folder contents with pagination support
            if folder_id == "root":
                url = "https://graph.microsoft.com/v1.0/me/drive/root/children"
            else:
                url = f"https://graph.microsoft.com/v1.0/me/drive/items/{folder_id}/children"
            
            # Add top parameter for server-side pagination (if supported)
            url += f"?$top=5000"  # Request larger batch, we'll paginate on our side
            
            response = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
            
            if response.status_code != 200:
                raise HTTPException(status_code=400, detail="Failed to browse folder")
            
            data = response.json()
            items = data.get("value", [])
            
            # Get folder information for breadcrumbs (concurrent request)
            current_folder_info = {}
            breadcrumbs_task = None
            
            if folder_id != "root":
                folder_response = await client.get(
                    f"https://graph.microsoft.com/v1.0/me/drive/items/{folder_id}",
                    headers={"Authorization": f"Bearer {access_token}"}
                )
                if folder_response.status_code == 200:
                    current_folder_info = folder_response.json()
                    # Start breadcrumbs building concurrently
                    breadcrumbs_task = asyncio.create_task(
                        build_breadcrumbs(client, access_token, current_folder_info)
                    )
            
            # Process items efficiently
            folders = []
            files = []
            total_size = 0
            
            # Define supported media types (as constants for performance)
            video_extensions = {'.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.flv', '.m4v', '.3gp', '.ogv'}
            photo_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg'}
            audio_extensions = {'.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.aiff', '.alac'}
            video_mime_types = {'video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-ms-wmv', 
                              'video/webm', 'video/x-matroska', 'video/x-flv', 'video/3gpp', 'video/ogg'}
            photo_mime_types = {'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 
                              'image/tiff', 'image/svg+xml'}
            audio_mime_types = {'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/ogg', 
                              'audio/aac', 'audio/x-ms-wma', 'audio/opus', 'audio/aiff', 'audio/alac'}
            
            # Batch process items for better performance
            for item in items:
                item_name = item.get("name", "").lower()
                item_size = item.get("size", 0)
                total_size += item_size
                
                # Build full path efficiently
                current_path = current_folder_info.get("name", "Root") if folder_id != "root" else "Root"
                full_path = f"{current_path}/{item['name']}" if current_path != "Root" else item['name']
                
                if item.get("folder"):
                    # It's a folder
                    folder_item = FileItem(
                        id=item["id"],
                        name=item["name"],
                        type="folder",
                        size=item_size,  # Use folder size from API directly (faster)
                        modified=item.get("lastModifiedDateTime"),
                        created=item.get("createdDateTime"),
                        full_path=full_path,
                        is_media=False
                    )
                    folders.append(folder_item)
                else:
                    # It's a file - optimize media type detection
                    mime_type = item.get("file", {}).get("mimeType", "")
                    
                    # Fast extension lookup using sets
                    file_ext = None
                    if '.' in item_name:
                        file_ext = '.' + item_name.split('.')[-1]
                    
                    is_video = (file_ext in video_extensions) or (mime_type in video_mime_types)
                    is_photo = (file_ext in photo_extensions) or (mime_type in photo_mime_types)
                    is_audio = (file_ext in audio_extensions) or (mime_type in audio_mime_types)
                    
                    media_type = "video" if is_video else "photo" if is_photo else "audio" if is_audio else "other"
                    
                    file_item = FileItem(
                        id=item["id"],
                        name=item["name"],
                        type="file",
                        size=item_size,
                        modified=item.get("lastModifiedDateTime"),
                        created=item.get("createdDateTime"),
                        mime_type=mime_type,
                        full_path=full_path,
                        is_media=is_video or is_photo or is_audio,
                        media_type=media_type,
                        thumbnail_url=get_thumbnail_url(item),
                        download_url=item.get("@microsoft.graph.downloadUrl")
                    )
                    files.append(file_item)
            
            # Filter by file type if specified
            if file_types != "all":
                if file_types == "folder":
                    files = []
                elif file_types == "video":
                    files = [f for f in files if f.media_type == "video"]
                    folders = []
                elif file_types == "audio":
                    files = [f for f in files if f.media_type == "audio"]
                    folders = []
                elif file_types == "photo":
                    files = [f for f in files if f.media_type == "photo"]
                    folders = []
            
            # Combine and sort items efficiently
            all_items = folders + files
            
            # Sort items
            if sort_by == "name":
                all_items.sort(key=lambda x: x.name.lower(), reverse=(sort_order == "desc"))
            elif sort_by == "size":
                all_items.sort(key=lambda x: x.size or 0, reverse=(sort_order == "desc"))
            elif sort_by == "modified":
                all_items.sort(key=lambda x: x.modified or "", reverse=(sort_order == "desc"))
            elif sort_by == "type":
                all_items.sort(key=lambda x: (x.type, x.name.lower()), reverse=(sort_order == "desc"))
            
            # Apply pagination
            total_items = len(all_items)
            start_idx = (page - 1) * page_size
            end_idx = start_idx + page_size
            paginated_items = all_items[start_idx:end_idx]
            
            # Separate back into folders and files for response
            paginated_folders = [item for item in paginated_items if item.type == "folder"]
            paginated_files = [item for item in paginated_items if item.type == "file"]
            
            # Wait for breadcrumbs if needed
            breadcrumbs = []
            if breadcrumbs_task:
                breadcrumbs = await breadcrumbs_task
            elif folder_id == "root":
                breadcrumbs = [{"name": "Root", "id": "root"}]
            
            # Calculate pagination info
            total_pages = (total_items + page_size - 1) // page_size
            has_next = page < total_pages
            has_prev = page > 1
            
            return {
                "current_folder": current_folder_info.get("name", "Root"),
                "parent_folder": current_folder_info.get("parentReference", {}).get("id"),
                "breadcrumbs": breadcrumbs,
                "folders": paginated_folders,
                "files": paginated_files,
                "total_size": total_size,
                "pagination": {
                    "current_page": page,
                    "page_size": page_size,
                    "total_items": total_items,
                    "total_pages": total_pages,
                    "has_next": has_next,
                    "has_prev": has_prev,
                    "start_index": start_idx,
                    "end_index": min(end_idx, total_items)
                },
                "sorting": {
                    "sort_by": sort_by,
                    "sort_order": sort_order
                },
                "filters": {
                    "file_types": file_types
                }
            }
            
    except Exception as e:
        logger.error(f"Browse folder error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to browse folder")

async def build_breadcrumbs(client: httpx.AsyncClient, access_token: str, folder_info: dict) -> List[Dict[str, str]]:
    """Build breadcrumb navigation"""
    breadcrumbs = [{"name": "Root", "id": "root"}]
    
    if not folder_info:
        return breadcrumbs
    
    # Get parent chain
    current = folder_info
    path_items = []
    
    while current and current.get("parentReference"):
        path_items.append({"name": current["name"], "id": current["id"]})
        parent_id = current["parentReference"].get("id")
        
        if parent_id and parent_id != "root":
            try:
                parent_response = await client.get(
                    f"https://graph.microsoft.com/v1.0/me/drive/items/{parent_id}",
                    headers={"Authorization": f"Bearer {access_token}"}
                )
                if parent_response.status_code == 200:
                    current = parent_response.json()
                else:
                    break
            except:
                break
        else:
            break
    
    # Reverse to get correct order
    path_items.reverse()
    breadcrumbs.extend(path_items)
    
    return breadcrumbs

def get_thumbnail_url(item: dict) -> Optional[str]:
    """Extract thumbnail URL from OneDrive item"""
    thumbnails = item.get("thumbnails", [])
    if thumbnails and len(thumbnails) > 0:
        thumbnail = thumbnails[0]
        if "large" in thumbnail:
            return thumbnail["large"]["url"]
        elif "medium" in thumbnail:
            return thumbnail["medium"]["url"]
        elif "small" in thumbnail:
            return thumbnail["small"]["url"]
    return None
@app.get("/api/explorer/search")
async def search_files(
    q: str, 
    page: int = 1, 
    page_size: int = 100,
    file_types: str = "all",  # all, video, audio, photo, folder
    sort_by: str = "relevance",
    sort_order: str = "desc",
    authorization: str = Header(...)
):
    """Search files across entire OneDrive with pagination and performance optimizations"""
    try:
        access_token = authorization.replace("Bearer ", "")
        
        # Validate parameters
        page = max(1, page)
        page_size = min(max(1, page_size), 1000)
        q = q.strip()
        
        if not q:
            raise HTTPException(status_code=400, detail="Search query cannot be empty")
        
        # Use concurrent requests for better performance
        async with httpx.AsyncClient(timeout=90.0) as client:
            # Microsoft Graph search with optimized query
            search_query = f"'{q}'"
            if file_types == "video":
                search_query += " AND (file.mimeType:'video/' OR name:.mp4 OR name:.mkv OR name:.avi)"
            elif file_types == "audio":
                search_query += " AND (file.mimeType:'audio/' OR name:.mp3 OR name:.wav OR name:.flac)"
            elif file_types == "photo":
                search_query += " AND (file.mimeType:'image/' OR name:.jpg OR name:.png OR name:.gif)"
            elif file_types == "folder":
                search_query += " AND folder"
            
            # Request larger batch for server-side optimization
            url = f"https://graph.microsoft.com/v1.0/me/drive/root/search(q={search_query})?$top=2000"
            
            response = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
            
            if response.status_code != 200:
                raise HTTPException(status_code=400, detail="Search failed")
            
            data = response.json()
            items = data.get("value", [])
            
            # Process search results efficiently
            results = []
            
            # Optimized media type detection (same as browse)
            video_extensions = {'.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.flv', '.m4v', '.3gp', '.ogv'}
            photo_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg'}
            audio_extensions = {'.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.aiff', '.alac'}
            video_mime_types = {'video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-ms-wmv', 
                              'video/webm', 'video/x-matroska', 'video/x-flv', 'video/3gpp', 'video/ogg'}
            photo_mime_types = {'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 
                              'image/tiff', 'image/svg+xml'}
            audio_mime_types = {'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/ogg', 
                              'audio/aac', 'audio/x-ms-wma', 'audio/opus', 'audio/aiff', 'audio/alac'}
            
            # Batch process for performance
            full_path_tasks = []
            for item in items:
                # Start full path calculation concurrently for better performance
                if item.get("parentReference"):
                    task = asyncio.create_task(get_full_path_optimized(client, access_token, item))
                    full_path_tasks.append((item, task))
                else:
                    full_path_tasks.append((item, None))
            
            # Process items with concurrent path resolution
            for item, path_task in full_path_tasks:
                item_name = item.get("name", "").lower()
                
                # Get full path
                if path_task:
                    try:
                        full_path = await path_task
                    except:
                        full_path = item["name"]  # Fallback to name only
                else:
                    full_path = item["name"]
                
                if item.get("folder"):
                    # It's a folder
                    if file_types == "all" or file_types == "folder":
                        results.append(FileItem(
                            id=item["id"],
                            name=item["name"],
                            type="folder",
                            size=item.get("size", 0),
                            modified=item.get("lastModifiedDateTime"),
                            created=item.get("createdDateTime"),
                            full_path=full_path,
                            is_media=False
                        ))
                else:
                    # It's a file - optimize media type detection
                    mime_type = item.get("file", {}).get("mimeType", "")
                    
                    # Fast extension lookup
                    file_ext = None
                    if '.' in item_name:
                        file_ext = '.' + item_name.split('.')[-1]
                    
                    is_video = (file_ext in video_extensions) or (mime_type in video_mime_types)
                    is_photo = (file_ext in photo_extensions) or (mime_type in photo_mime_types)
                    is_audio = (file_ext in audio_extensions) or (mime_type in audio_mime_types)
                    
                    media_type = "video" if is_video else "photo" if is_photo else "audio" if is_audio else "other"
                    
                    # Filter by file type
                    if file_types == "all" or file_types == media_type:
                        results.append(FileItem(
                            id=item["id"],
                            name=item["name"],
                            type="file",
                            size=item.get("size", 0),
                            modified=item.get("lastModifiedDateTime"),
                            created=item.get("createdDateTime"),
                            mime_type=mime_type,
                            full_path=full_path,
                            is_media=is_video or is_photo or is_audio,
                            media_type=media_type,
                            thumbnail_url=get_thumbnail_url(item),
                            download_url=item.get("@microsoft.graph.downloadUrl")
                        ))
            
            # Sort results efficiently
            if sort_by == "relevance":
                # Sort by relevance: exact matches first, then partial matches
                def relevance_score(item):
                    name_lower = item.name.lower()
                    query_lower = q.lower()
                    if name_lower == query_lower:
                        return 0  # Exact match
                    elif name_lower.startswith(query_lower):
                        return 1  # Starts with query
                    elif query_lower in name_lower:
                        return 2  # Contains query
                    else:
                        return 3  # Other match
                
                results.sort(key=relevance_score)
            elif sort_by == "name":
                results.sort(key=lambda x: x.name.lower(), reverse=(sort_order == "desc"))
            elif sort_by == "size":
                results.sort(key=lambda x: x.size or 0, reverse=(sort_order == "desc"))
            elif sort_by == "modified":
                results.sort(key=lambda x: x.modified or "", reverse=(sort_order == "desc"))
            elif sort_by == "type":
                results.sort(key=lambda x: (x.type, x.name.lower()), reverse=(sort_order == "desc"))
            
            # Apply pagination
            total_results = len(results)
            start_idx = (page - 1) * page_size
            end_idx = start_idx + page_size
            paginated_results = results[start_idx:end_idx]
            
            # Calculate pagination info
            total_pages = (total_results + page_size - 1) // page_size
            has_next = page < total_pages
            has_prev = page > 1
            
            return {
                "results": paginated_results,
                "query": q,
                "pagination": {
                    "current_page": page,
                    "page_size": page_size,
                    "total_items": total_results,
                    "total_pages": total_pages,
                    "has_next": has_next,
                    "has_prev": has_prev,
                    "start_index": start_idx,
                    "end_index": min(end_idx, total_results)
                },
                "sorting": {
                    "sort_by": sort_by,
                    "sort_order": sort_order
                },
                "filters": {
                    "file_types": file_types
                }
            }
            
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        raise HTTPException(status_code=500, detail="Search failed")

async def get_full_path_optimized(client: httpx.AsyncClient, access_token: str, item: dict) -> str:
    """Optimized full path calculation with caching"""
    try:
        path_parts = [item["name"]]
        current = item
        depth = 0
        max_depth = 10  # Prevent infinite loops
        
        while current.get("parentReference") and current["parentReference"].get("id") != "root" and depth < max_depth:
            parent_id = current["parentReference"]["id"]
            
            # Use timeout for individual requests
            try:
                parent_response = await asyncio.wait_for(
                    client.get(
                        f"https://graph.microsoft.com/v1.0/me/drive/items/{parent_id}",
                        headers={"Authorization": f"Bearer {access_token}"}
                    ),
                    timeout=5.0  # 5 second timeout per request
                )
                
                if parent_response.status_code == 200:
                    parent = parent_response.json()
                    path_parts.append(parent["name"])
                    current = parent
                    depth += 1
                else:
                    break
            except asyncio.TimeoutError:
                break
        
        path_parts.reverse()
        return "/".join(path_parts)
    except:
        return item["name"]

async def get_full_path(client: httpx.AsyncClient, access_token: str, item: dict) -> str:
    """Get full path for an item"""
    try:
        path_parts = [item["name"]]
        current = item
        
        while current.get("parentReference") and current["parentReference"].get("id") != "root":
            parent_id = current["parentReference"]["id"]
            parent_response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/items/{parent_id}",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if parent_response.status_code == 200:
                parent = parent_response.json()
                path_parts.append(parent["name"])
                current = parent
            else:
                break
        
        path_parts.reverse()
        return "/".join(path_parts)
    except:
        return item["name"]

# Legacy endpoints for compatibility
@app.get("/api/files")
async def list_files(authorization: str = Header(...)):
    try:
        access_token = authorization.replace("Bearer ", "")
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://graph.microsoft.com/v1.0/me/drive/root/children",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if response.status_code != 200:
                logger.error(f"Failed to fetch files: {response.status_code}")
                raise HTTPException(status_code=400, detail="Failed to fetch files")
            
            files = response.json()
            logger.info(f"Retrieved {len(files.get('value', []))} files from OneDrive")
            
            # Filter for video and audio files
            media_files = []
            video_extensions = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.flv', '.m4v', '.3gp', '.ogv']
            audio_extensions = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.aiff', '.alac']
            video_mime_types = ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-ms-wmv', 
                              'video/webm', 'video/x-matroska', 'video/x-flv', 'video/3gpp', 'video/ogg']
            audio_mime_types = ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/ogg', 
                              'audio/aac', 'audio/x-ms-wma', 'audio/opus', 'audio/aiff', 'audio/alac']
            
            for file in files.get("value", []):
                is_video = False
                is_audio = False
                file_name = file.get("name", "").lower()
                
                # Check by file extension
                if any(file_name.endswith(ext) for ext in video_extensions):
                    is_video = True
                    logger.info(f"Found video by extension: {file_name}")
                elif any(file_name.endswith(ext) for ext in audio_extensions):
                    is_audio = True
                    logger.info(f"Found audio by extension: {file_name}")
                
                # Check by MIME type if available
                if file.get("file") and file.get("file", {}).get("mimeType"):
                    mime_type = file["file"]["mimeType"]
                    if mime_type in video_mime_types or mime_type.startswith("video/"):
                        is_video = True
                        logger.info(f"Found video by MIME type: {file_name} ({mime_type})")
                    elif mime_type in audio_mime_types or mime_type.startswith("audio/"):
                        is_audio = True
                        logger.info(f"Found audio by MIME type: {file_name} ({mime_type})")
                
                if is_video or is_audio:
                    media_files.append({
                        "id": file["id"],
                        "name": file["name"],
                        "size": file.get("size", 0),
                        "mimeType": file.get("file", {}).get("mimeType", "video/mp4" if is_video else "audio/mpeg"),
                        "downloadUrl": file.get("@microsoft.graph.downloadUrl"),
                        "webUrl": file.get("webUrl"),
                        "thumbnails": file.get("thumbnails", []),
                        "media_type": "video" if is_video else "audio"
                    })
                else:
                    # Log non-media files for debugging
                    logger.info(f"Non-media file: {file_name} (MIME: {file.get('file', {}).get('mimeType', 'N/A')})")
            
            logger.info(f"Found {len(media_files)} media files")
            return {"videos": media_files}  # Keep "videos" key for backward compatibility
            
    except Exception as e:
        logger.error(f"List files error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to list files")

@app.get("/api/files/all")
async def list_all_files(authorization: str = Header(...)):
    """List all video files recursively from all folders"""
    try:
        access_token = authorization.replace("Bearer ", "")
        
        async def get_files_recursive(client, folder_id="root", folder_path="", max_depth=5, current_depth=0):
            """Recursively get all files from a folder and its subfolders with depth limit"""
            all_files = []
            
            # Prevent infinite recursion
            if current_depth > max_depth:
                logger.warning(f"Max depth reached for folder: {folder_path}")
                return all_files
            
            # Get files from current folder
            if folder_id == "root":
                url = "https://graph.microsoft.com/v1.0/me/drive/root/children"
            else:
                url = f"https://graph.microsoft.com/v1.0/me/drive/items/{folder_id}/children"
            
            response = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
            
            if response.status_code != 200:
                logger.error(f"Failed to fetch files from {folder_path}: {response.status_code}")
                return all_files
            
            files = response.json()
            
            for file in files.get("value", []):
                file_path = f"{folder_path}/{file['name']}" if folder_path else file['name']
                
                if file.get("folder"):
                    # It's a folder, recurse into it
                    logger.info(f"Exploring folder: {file_path} (depth: {current_depth + 1})")
                    subfolder_files = await get_files_recursive(client, file["id"], file_path, max_depth, current_depth + 1)
                    all_files.extend(subfolder_files)
                else:
                    # It's a file, add folder path info
                    file["folder_path"] = folder_path
                    all_files.append(file)
            
            return all_files
        
        async with httpx.AsyncClient(timeout=30.0) as client:  # Add timeout
            all_files = await get_files_recursive(client)
            
            logger.info(f"Retrieved {len(all_files)} total files from OneDrive (including subfolders)")
            
            # Filter for video and audio files
            media_files = []
            video_extensions = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.flv', '.m4v', '.3gp', '.ogv']
            audio_extensions = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.aiff', '.alac']
            video_mime_types = ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-ms-wmv', 
                              'video/webm', 'video/x-matroska', 'video/x-flv', 'video/3gpp', 'video/ogg']
            audio_mime_types = ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/ogg', 
                              'audio/aac', 'audio/x-ms-wma', 'audio/opus', 'audio/aiff', 'audio/alac']
            
            for file in all_files:
                is_video = False
                is_audio = False
                file_name = file.get("name", "").lower()
                folder_path = file.get("folder_path", "")
                full_path = f"{folder_path}/{file_name}" if folder_path else file_name
                
                # Check by file extension
                if any(file_name.endswith(ext) for ext in video_extensions):
                    is_video = True
                    logger.info(f"Found video by extension: {full_path}")
                elif any(file_name.endswith(ext) for ext in audio_extensions):
                    is_audio = True
                    logger.info(f"Found audio by extension: {full_path}")
                
                # Check by MIME type if available
                if file.get("file") and file.get("file", {}).get("mimeType"):
                    mime_type = file["file"]["mimeType"]
                    if mime_type in video_mime_types or mime_type.startswith("video/"):
                        is_video = True
                        logger.info(f"Found video by MIME type: {full_path} ({mime_type})")
                    elif mime_type in audio_mime_types or mime_type.startswith("audio/"):
                        is_audio = True
                        logger.info(f"Found audio by MIME type: {full_path} ({mime_type})")
                
                if is_video or is_audio:
                    media_files.append({
                        "id": file["id"],
                        "name": file["name"],
                        "folder_path": folder_path,
                        "full_path": full_path,
                        "size": file.get("size", 0),
                        "mimeType": file.get("file", {}).get("mimeType", "video/mp4" if is_video else "audio/mpeg"),
                        "downloadUrl": file.get("@microsoft.graph.downloadUrl"),
                        "webUrl": file.get("webUrl"),
                        "thumbnails": file.get("thumbnails", []),
                        "media_type": "video" if is_video else "audio"
                    })
            
            logger.info(f"Found {len(media_files)} media files total")
            return {"videos": media_files}  # Keep "videos" key for backward compatibility
            
    except asyncio.TimeoutError:
        logger.error("Timeout while fetching files from OneDrive")
        raise HTTPException(status_code=504, detail="Request timeout - OneDrive has too many files to process")
    except Exception as e:
        logger.error(f"List all files error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to list all files")

@app.get("/api/files/search")
async def search_files(q: str, authorization: str = Header(...)):
    try:
        access_token = authorization.replace("Bearer ", "")
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/root/search(q='{q}')",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=400, detail="Search failed")
            
            files = response.json()
            
            # Filter for video and audio files
            media_files = []
            video_extensions = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.flv', '.m4v', '.3gp', '.ogv']
            audio_extensions = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.opus', '.aiff', '.alac']
            video_mime_types = ['video/mp4', 'video/x-msvideo', 'video/quicktime', 'video/x-ms-wmv', 
                              'video/webm', 'video/x-matroska', 'video/x-flv', 'video/3gpp', 'video/ogg']
            audio_mime_types = ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/ogg', 
                              'audio/aac', 'audio/x-ms-wma', 'audio/opus', 'audio/aiff', 'audio/alac']
            
            for file in files.get("value", []):
                is_video = False
                is_audio = False
                file_name = file.get("name", "").lower()
                
                # Check by file extension
                if any(file_name.endswith(ext) for ext in video_extensions):
                    is_video = True
                elif any(file_name.endswith(ext) for ext in audio_extensions):
                    is_audio = True
                
                # Check by MIME type if available
                if file.get("file") and file.get("file", {}).get("mimeType"):
                    mime_type = file["file"]["mimeType"]
                    if mime_type in video_mime_types or mime_type.startswith("video/"):
                        is_video = True
                    elif mime_type in audio_mime_types or mime_type.startswith("audio/"):
                        is_audio = True
                
                if is_video or is_audio:
                    media_files.append({
                        "id": file["id"],
                        "name": file["name"],
                        "size": file.get("size", 0),
                        "mimeType": file.get("file", {}).get("mimeType", "video/mp4" if is_video else "audio/mpeg"),
                        "downloadUrl": file.get("@microsoft.graph.downloadUrl"),
                        "webUrl": file.get("webUrl"),
                        "thumbnails": file.get("thumbnails", []),
                        "media_type": "video" if is_video else "audio"
                    })
            
            return {"videos": media_files}  # Keep "videos" key for backward compatibility
    except Exception as e:
        logger.error(f"Search files error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to search files")

@app.get("/api/stream/{item_id}")
async def stream_media(
    item_id: str, 
    request: Request, 
    authorization: str = Header(None), 
    token: str = None, 
    quality: str = None,
    chunk_size: int = None,
    buffer_size: int = 30,
    mobile_mkv: str = None,
    low_bandwidth: str = None,
    test: str = None
):
    """Ultra-optimized streaming endpoint with enhanced performance for MP4/MKV and 1080p support"""
    try:
        # Handle test requests for network speed detection
        if test:
            return Response(
                content="OK",
                status_code=200,
                headers={
                    "Content-Type": "text/plain",
                    "Cache-Control": "no-cache",
                    "Content-Length": "2"
                }
            )
        
        # Get access token
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        async with httpx.AsyncClient() as client:
            # Get file metadata
            response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/items/{item_id}",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if response.status_code != 200:
                logger.error(f"Failed to fetch file info: {response.status_code}")
                raise HTTPException(status_code=404, detail="File not found")
            
            file_info = response.json()
            download_url = file_info.get("@microsoft.graph.downloadUrl")
            
            if not download_url:
                logger.error("No download URL available for file")
                raise HTTPException(status_code=404, detail="Download URL not available")
            
            # Enhanced file format detection
            file_size = file_info.get("size", 0)
            file_name = file_info.get("name", "").lower()
            mime_type = file_info.get("file", {}).get("mimeType", "")
            
            # Enhanced device detection
            user_agent = request.headers.get("user-agent", "").lower()
            is_mobile_chrome = ("chrome" in user_agent or "crios" in user_agent) and ("mobile" in user_agent or "android" in user_agent)
            is_safari_mobile = "safari" in user_agent and "mobile" in user_agent and "chrome" not in user_agent
            is_mobile = is_mobile_chrome or is_safari_mobile or "mobile" in user_agent
            
            # Ultra-enhanced MIME type detection with performance optimization
            def get_optimized_mime_type(filename, original_mime, is_mobile_chrome=False, is_mobile=False):
                """Get browser-compatible MIME type with ultra performance optimizations"""
                # Video formats with performance priority
                if filename.endswith('.mp4'):
                    return "video/mp4"
                elif filename.endswith('.webm'):
                    return "video/webm"
                elif filename.endswith('.mkv'):
                    # Enhanced MKV handling for different platforms
                    if mobile_mkv == "true" or is_mobile_chrome:
                        logger.info(f"Mobile MKV optimization for: {filename}")
                        # Use H.264 container hint for better mobile compatibility
                        return "video/mp4"  # Mobile fallback for better performance
                    else:
                        return "video/x-matroska"
                elif filename.endswith('.avi'):
                    if is_mobile:
                        return "video/mp4"  # Mobile fallback
                    return "video/x-msvideo"
                elif filename.endswith('.mov'):
                    return "video/quicktime"
                elif filename.endswith('.wmv'):
                    if is_mobile:
                        return "video/mp4"  # Mobile fallback
                    return "video/x-ms-wmv"
                elif filename.endswith('.m4v'):
                    return "video/mp4"
                elif filename.endswith('.flv'):
                    return "video/x-flv"
                elif filename.endswith('.3gp'):
                    return "video/3gpp"
                # Audio formats
                elif filename.endswith('.mp3'):
                    return "audio/mpeg"
                elif filename.endswith('.wav'):
                    return "audio/wav"
                elif filename.endswith('.flac'):
                    return "audio/flac"
                elif filename.endswith('.m4a'):
                    return "audio/mp4"
                elif filename.endswith('.ogg'):
                    return "audio/ogg"
                elif filename.endswith('.aac'):
                    return "audio/aac"
                elif filename.endswith('.opus'):
                    return "audio/opus"
                else:
                    return original_mime or "application/octet-stream"
            
            # Get optimized MIME type
            compatible_mime = get_optimized_mime_type(file_name, mime_type, is_mobile_chrome, is_mobile)
            
            # File format specific optimizations
            is_mkv = file_name.endswith('.mkv')
            is_mp4 = file_name.endswith('.mp4')
            is_video = any(file_name.endswith(ext) for ext in ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv'])
            is_audio = any(file_name.endswith(ext) for ext in ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'])
            
            # Ultra-adaptive chunk sizing for maximum performance
            if chunk_size is None:
                if low_bandwidth == "true":
                    # Low bandwidth optimization
                    if is_mkv:
                        chunk_size = 16384  # 16KB for MKV on slow connections
                    else:
                        chunk_size = 32768  # 32KB for other formats
                elif is_mkv:
                    # MKV-specific optimizations
                    if mobile_mkv == "true" or is_mobile_chrome:
                        chunk_size = 32768  # 32KB for mobile MKV
                    else:
                        chunk_size = 65536  # 64KB for desktop MKV
                elif is_mp4:
                    # MP4 optimizations for 1080p content
                    if file_size > 2 * 1024 * 1024 * 1024:  # > 2GB (likely 1080p+)
                        chunk_size = 2 * 1024 * 1024  # 2MB for large 1080p files
                    elif file_size > 1 * 1024 * 1024 * 1024:  # > 1GB
                        chunk_size = 1 * 1024 * 1024  # 1MB for medium 1080p files
                    else:
                        chunk_size = 512 * 1024  # 512KB for smaller files
                elif file_size > 500 * 1024 * 1024:  # > 500MB
                    chunk_size = 1 * 1024 * 1024  # 1MB for large files
                elif file_size > 100 * 1024 * 1024:  # > 100MB
                    chunk_size = 512 * 1024   # 512KB for medium files
                else:
                    chunk_size = 65536  # 64KB for small files
            
            # Quality-based optimizations
            quality_multiplier = 1.0
            if quality:
                if quality == "1080p":
                    quality_multiplier = 1.5  # Larger chunks for 1080p
                elif quality == "720p":
                    quality_multiplier = 1.2  # Slightly larger chunks for 720p
                elif quality == "480p" or quality == "360p":
                    quality_multiplier = 0.8  # Smaller chunks for lower quality
            
            chunk_size = int(chunk_size * quality_multiplier)
            
            logger.info(f"Ultra-optimized streaming: {file_name} | MIME: {compatible_mime} | Size: {file_size} | Chunk: {chunk_size} | Quality: {quality} | Mobile: {is_mobile} | Low BW: {low_bandwidth}")
            
            # Enhanced timeout configuration based on file type and size
            base_timeout = 30.0
            if low_bandwidth == "true":
                base_timeout = 90.0  # Longer timeouts for slow connections
            elif is_mkv:
                base_timeout = 60.0  # Longer timeouts for MKV
            elif file_size > 1 * 1024 * 1024 * 1024:  # > 1GB
                base_timeout = 120.0  # Very long timeouts for large files
            
            # Handle range requests for seeking with enhanced performance
            range_header = request.headers.get("Range")
            if range_header:
                try:
                    # Parse range header
                    range_match = range_header.replace("bytes=", "").split("-")
                    start = int(range_match[0]) if range_match[0] else 0
                    end = int(range_match[1]) if range_match[1] else file_size - 1
                    
                    # Validate range
                    start = max(0, min(start, file_size - 1))
                    end = max(start, min(end, file_size - 1))
                    
                    # Smart range optimization for different formats
                    if is_mkv and (mobile_mkv == "true" or is_mobile_chrome):
                        # Smaller ranges for MKV on mobile for better compatibility
                        max_range = 3 * 1024 * 1024  # 3MB max for MKV on mobile
                        if (end - start + 1) > max_range:
                            end = start + max_range - 1
                    elif is_mp4 and file_size > 1 * 1024 * 1024 * 1024:  # Large MP4 files (1080p)
                        # Larger ranges for MP4 1080p content for better performance
                        max_range = 20 * 1024 * 1024  # 20MB max for large MP4
                        if (end - start + 1) > max_range:
                            end = start + max_range - 1
                    elif low_bandwidth == "true":
                        # Smaller ranges for low bandwidth
                        max_range = 2 * 1024 * 1024  # 2MB max for slow connections
                        if (end - start + 1) > max_range:
                            end = start + max_range - 1
                    
                    logger.info(f"Enhanced range request: bytes={start}-{end}/{file_size} | Format: {file_name.split('.')[-1].upper()}")
                    
                    # Ultra-optimized range streaming
                    async def generate_range():
                        try:
                            timeout_config = httpx.Timeout(
                                connect=15.0,
                                read=base_timeout * 2,  # Double read timeout for range requests
                                write=60.0,
                                pool=60.0
                            )
                            
                            async with httpx.AsyncClient(timeout=timeout_config) as stream_client:
                                range_headers = {"Range": f"bytes={start}-{end}"}
                                async with stream_client.stream("GET", download_url, headers=range_headers) as media_response:
                                    if media_response.status_code not in [200, 206]:
                                        logger.error(f"Range request failed: {media_response.status_code}")
                                        return
                                    
                                    # Stream with adaptive chunk size and performance monitoring
                                    bytes_streamed = 0
                                    last_log_time = 0
                                    start_time = asyncio.get_event_loop().time()
                                    
                                    async for chunk in media_response.aiter_bytes(chunk_size=chunk_size):
                                        yield chunk
                                        bytes_streamed += len(chunk)
                                        
                                        # Performance logging (throttled)
                                        current_time = asyncio.get_event_loop().time()
                                        if current_time - last_log_time > 5.0:  # Log every 5 seconds
                                            progress = (bytes_streamed / (end - start + 1)) * 100
                                            speed = bytes_streamed / (current_time - start_time + 0.1)  # Avoid division by zero
                                            logger.debug(f"Range streaming: {progress:.1f}% | Speed: {speed/1024:.1f} KB/s")
                                            last_log_time = current_time
                                            
                        except Exception as e:
                            logger.error(f"Error in enhanced range streaming: {str(e)}")
                            return
                    
                    # Enhanced headers for range response with performance optimizations
                    range_headers = {
                        "Accept-Ranges": "bytes",
                        "Content-Range": f"bytes {start}-{end}/{file_size}",
                        "Content-Length": str(end - start + 1),
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
                        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
                        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
                    }
                    
                    # Format-specific optimizations
                    if is_mkv:
                        range_headers.update({
                            "X-Content-Type-Options": "nosniff",
                            "Content-Disposition": "inline",
                        })
                        
                        if mobile_mkv == "true" or is_mobile_chrome:
                            # Mobile Chrome specific headers for MKV
                            range_headers.update({
                                "Connection": "keep-alive",
                                "Keep-Alive": "timeout=30, max=100",
                                "Vary": "Accept-Encoding, User-Agent",
                            })
                    elif is_mp4:
                        # MP4 performance optimizations
                        range_headers.update({
                            "X-Content-Duration": str(buffer_size),  # Hint for buffer size
                            "X-Content-Type-Options": "nosniff",
                        })
                    
                    # Low bandwidth optimizations
                    if low_bandwidth == "true":
                        range_headers.update({
                            "Cache-Control": "public, max-age=7200, stale-while-revalidate=172800",  # Longer cache for slow connections
                            "Connection": "keep-alive",
                            "Keep-Alive": "timeout=60, max=50",
                        })
                    
                    return StreamingResponse(
                        generate_range(),
                        status_code=206,
                        media_type=compatible_mime,
                        headers=range_headers
                    )
                    
                except (ValueError, IndexError) as e:
                    logger.error(f"Invalid range header: {range_header}, error: {e}")
                    # Fall back to full file streaming
            
            # Full file streaming with optimizations
            async def generate_full():
                try:
                    timeout_config = httpx.Timeout(
                        connect=15.0,
                        read=180.0 if is_mkv else 120.0,
                        write=60.0,
                        pool=60.0
                    )
                    
                    async with httpx.AsyncClient(timeout=timeout_config) as stream_client:
                        async with stream_client.stream("GET", download_url) as media_response:
                            if media_response.status_code != 200:
                                logger.error(f"Full streaming failed: {media_response.status_code}")
                                return
                            
                            # Stream with optimized chunk size
                            bytes_streamed = 0
                            async for chunk in media_response.aiter_bytes(chunk_size=chunk_size):
                                yield chunk
                                bytes_streamed += len(chunk)
                                
                                # Progress logging for large files
                                if file_size > 100 * 1024 * 1024 and bytes_streamed % (chunk_size * 200) == 0:
                                    progress = (bytes_streamed / file_size) * 100
                                    logger.debug(f"Full streaming progress: {progress:.1f}%")
                                    
                except Exception as e:
                    logger.error(f"Error in full streaming: {str(e)}")
                    return
            
            # Headers for full file response
            full_headers = {
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
                "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
                "Cache-Control": "public, max-age=3600",
            }
            
            # MKV-specific headers for mobile Chrome
            if is_mkv:
                full_headers.update({
                    "X-Content-Type-Options": "nosniff",
                    "Content-Disposition": "inline",
                })
                
                if is_mobile_chrome:
                    # Mobile Chrome specific headers for MKV
                    full_headers.update({
                        "Connection": "keep-alive",
                        "Transfer-Encoding": "chunked",
                        "Vary": "Accept-Encoding",
                    })
            
            return StreamingResponse(
                generate_full(),
                media_type=compatible_mime,
                headers=full_headers
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stream media error: {str(e)}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to stream media: {str(e)}")

# User data endpoints
@app.post("/api/watch-history")
async def add_watch_history(
    history: WatchHistory,
    authorization: str = Header(...)
):
    try:
        access_token = authorization.replace("Bearer ", "")
        user_info = await get_user_info(access_token)
        user_id = user_info.get("id")
        
        if not user_id:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        history.timestamp = datetime.utcnow()
        
        await app.mongodb["users"].update_one(
            {"user_id": user_id},
            {
                "$push": {
                    "watch_history": {
                        "item_id": history.item_id,
                        "name": history.name,
                        "timestamp": history.timestamp
                    }
                }
            },
            upsert=True
        )
        
        return {"status": "success"}
    except Exception as e:
        logger.error(f"Watch history error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to update watch history")

@app.get("/api/watch-history")
async def get_watch_history(authorization: str = Header(...)):
    try:
        access_token = authorization.replace("Bearer ", "")
        user_info = await get_user_info(access_token)
        user_id = user_info.get("id")
        
        if not user_id:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        user_data = await app.mongodb["users"].find_one({"user_id": user_id})
        
        if not user_data:
            return {"watch_history": []}
        
        return {"watch_history": user_data.get("watch_history", [])}
    except Exception as e:
        logger.error(f"Get watch history error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get watch history")

@app.get("/api/thumbnail/{item_id}")
async def get_video_thumbnail(item_id: str, authorization: str = Header(None), token: str = None):
    try:
        # Try to get access token from header first, then from query parameter
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        async with httpx.AsyncClient() as client:
            # Get file info to check for thumbnails
            response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/items/{item_id}?expand=thumbnails",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="File not found")
            
            file_info = response.json()
            
            # Check if thumbnails exist
            thumbnails = file_info.get("thumbnails", [])
            if thumbnails and len(thumbnails) > 0:
                # Return the largest available thumbnail
                thumbnail_sizes = thumbnails[0]
                if "large" in thumbnail_sizes:
                    thumbnail_url = thumbnail_sizes["large"]["url"]
                elif "medium" in thumbnail_sizes:
                    thumbnail_url = thumbnail_sizes["medium"]["url"]
                elif "small" in thumbnail_sizes:
                    thumbnail_url = thumbnail_sizes["small"]["url"]
                else:
                    raise HTTPException(status_code=404, detail="No thumbnail available")
                
                # Fetch and return the thumbnail
                thumb_response = await client.get(thumbnail_url)
                if thumb_response.status_code == 200:
                    return StreamingResponse(
                        iter([thumb_response.content]),
                        media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=3600"}
                    )
            
            raise HTTPException(status_code=404, detail="No thumbnail available")
            
    except Exception as e:
        logger.error(f"Get thumbnail error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get thumbnail")

@app.get("/api/video-metadata/{item_id}")
async def get_video_metadata(item_id: str, authorization: str = Header(None), token: str = None):
    """Get enhanced video metadata for Netflix-style player"""
    try:
        # Try to get access token from header first, then from query parameter
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        async with httpx.AsyncClient() as client:
            # Get video file info
            response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/items/{item_id}",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="Video not found")
            
            file_info = response.json()
            
            # Extract enhanced metadata
            metadata = {
                "id": file_info["id"],
                "name": file_info["name"],
                "size": file_info.get("size", 0),
                "duration": None,  # Would be extracted from video file analysis
                "resolution": None,  # Would be extracted from video file analysis
                "bitrate": None,  # Would be extracted from video file analysis
                "codec": None,  # Would be extracted from video file analysis
                "available_qualities": ["Auto", "1080p", "720p", "480p", "360p"],
                "has_subtitles": False,  # Will be determined by subtitle search
                "thumbnail_url": get_thumbnail_url(file_info),
                "download_url": file_info.get("@microsoft.graph.downloadUrl"),
                "created": file_info.get("createdDateTime"),
                "modified": file_info.get("lastModifiedDateTime"),
                "mime_type": file_info.get("file", {}).get("mimeType", "")
            }
            
            return metadata
            
    except Exception as e:
        logger.error(f"Get video metadata error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get video metadata")

@app.get("/api/video-quality/{item_id}")
async def get_video_quality_options(item_id: str, authorization: str = Header(None), token: str = None):
    """Get available quality options for a video"""
    try:
        # Try to get access token from header first, then from query parameter
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        # In a real implementation, this would analyze the video file
        # For now, return standard Netflix-style quality options
        quality_options = [
            {
                "quality": "Auto",
                "label": "Auto",
                "description": "Adjusts automatically based on your connection",
                "bitrate": None,
                "resolution": None
            },
            {
                "quality": "1080p",
                "label": "Full HD",
                "description": "1920x1080",
                "bitrate": "5000k",
                "resolution": "1920x1080"
            },
            {
                "quality": "720p", 
                "label": "HD",
                "description": "1280x720",
                "bitrate": "2500k",
                "resolution": "1280x720"
            },
            {
                "quality": "480p",
                "label": "SD",
                "description": "854x480",
                "bitrate": "1000k", 
                "resolution": "854x480"
            },
            {
                "quality": "360p",
                "label": "Low",
                "description": "640x360",
                "bitrate": "500k",
                "resolution": "640x360"
            }
        ]
        
        return {"available_qualities": quality_options}
        
    except Exception as e:
        logger.error(f"Get video quality options error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get quality options")

@app.get("/api/video-timeline-thumbnails/{item_id}")
async def get_video_timeline_thumbnails(item_id: str, count: int = 10, authorization: str = Header(None), token: str = None):
    """Generate timeline thumbnails for video scrubbing (Netflix-style)"""
    try:
        # Try to get access token from header first, then from query parameter
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        # In a real implementation, this would:
        # 1. Download the video file temporarily
        # 2. Use FFmpeg to extract thumbnails at specific timestamps
        # 3. Upload thumbnails to a temporary storage
        # 4. Return URLs to the thumbnails
        
        # For now, return mock data structure
        thumbnails = []
        for i in range(count):
            percentage = (i / (count - 1)) * 100
            thumbnails.append({
                "timestamp": percentage,
                "thumbnail_url": f"https://via.placeholder.com/160x90?text={int(percentage)}%",
                "time_seconds": 0  # Would be calculated based on video duration
            })
        
        return {"thumbnails": thumbnails}
        
    except Exception as e:
        logger.error(f"Get timeline thumbnails error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get timeline thumbnails")

@app.get("/api/video-chapters/{item_id}")
async def get_video_chapters(item_id: str, authorization: str = Header(None), token: str = None):
    """Get video chapters for skip intro/outro functionality"""
    try:
        # Try to get access token from header first, then from query parameter
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        # In a real implementation, this would analyze the video for:
        # - Silent periods (likely intro/outro)
        # - Scene changes
        # - Audio pattern analysis
        # - Machine learning-based intro/outro detection
        
        # For now, return example chapter data
        chapters = {
            "intro": {
                "start": 0,
                "end": 90,  # 1:30
                "confidence": 0.85
            },
            "outro": {
                "start": None,  # Would be calculated as duration - outro_length
                "end": None,    # Would be video duration
                "confidence": 0.75
            },
            "chapters": [
                {
                    "title": "Opening",
                    "start": 0,
                    "end": 90
                },
                {
                    "title": "Main Content", 
                    "start": 90,
                    "end": None  # Would be calculated
                }
            ]
        }
        
        return chapters
        
    except Exception as e:
        logger.error(f"Get video chapters error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get video chapters")
    try:
        # Try to get access token from header first, then from query parameter
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        async with httpx.AsyncClient() as client:
            # Get file info to find potential subtitle files
            response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/items/{item_id}",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="File not found")
            
            file_info = response.json()
            parent_id = file_info.get("parentReference", {}).get("id")
            
            if not parent_id:
                raise HTTPException(status_code=404, detail="No subtitles found")
            
            # Search for subtitle files in the same directory
            folder_response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/items/{parent_id}/children",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if folder_response.status_code != 200:
                raise HTTPException(status_code=404, detail="No subtitles found")
            
            files = folder_response.json()
            video_name = file_info.get("name", "").lower()
            video_base_name = video_name.rsplit('.', 1)[0] if '.' in video_name else video_name
            
            subtitle_extensions = ['.srt', '.vtt', '.ass', '.ssa', '.sub']
            subtitle_files = []
            
            for file in files.get("value", []):
                file_name = file.get("name", "").lower()
                
                # Check if it's a subtitle file for this video
                if any(file_name.endswith(ext) for ext in subtitle_extensions):
                    file_base_name = file_name.rsplit('.', 1)[0] if '.' in file_name else file_name
                    
                    # Check if subtitle belongs to this video
                    if video_base_name in file_base_name or file_base_name in video_base_name:
                        subtitle_files.append({
                            "id": file["id"],
                            "name": file["name"],
                            "language": extract_language_from_filename(file["name"]),
                            "downloadUrl": file.get("@microsoft.graph.downloadUrl")
                        })
            
            return {"subtitles": subtitle_files}
            
    except Exception as e:
        logger.error(f"Get subtitles error: {str(e)}")
        raise HTTPException(status_code=404, detail="No subtitles found")

def extract_language_from_filename(filename):
    """Extract language code from subtitle filename"""
    filename_lower = filename.lower()
    
    # Common language patterns
    language_patterns = {
        'en': ['english', 'eng', '.en.'],
        'es': ['spanish', 'esp', '.es.'],
        'fr': ['french', 'fra', '.fr.'],
        'de': ['german', 'ger', '.de.'],
        'it': ['italian', 'ita', '.it.'],
        'pt': ['portuguese', 'por', '.pt.'],
        'ru': ['russian', 'rus', '.ru.'],
        'ja': ['japanese', 'jpn', '.ja.'],
        'ko': ['korean', 'kor', '.ko.'],
        'zh': ['chinese', 'chi', '.zh.'],
        'ar': ['arabic', 'ara', '.ar.'],
        'hi': ['hindi', 'hin', '.hi.'],
    }
    
    for lang_code, patterns in language_patterns.items():
        for pattern in patterns:
            if pattern in filename_lower:
                return lang_code
    
    return 'unknown'

@app.get("/api/subtitle-content/{item_id}")
async def get_subtitle_content(item_id: str, authorization: str = Header(None), token: str = None):
    try:
        # Try to get access token from header first, then from query parameter
        access_token = None
        if authorization:
            access_token = authorization.replace("Bearer ", "")
        elif token:
            access_token = token
        else:
            raise HTTPException(status_code=401, detail="Authorization required")
        
        async with httpx.AsyncClient() as client:
            # Get subtitle file info
            response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/drive/items/{item_id}",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="Subtitle file not found")
            
            file_info = response.json()
            download_url = file_info.get("@microsoft.graph.downloadUrl")
            
            if not download_url:
                raise HTTPException(status_code=404, detail="Download URL not available")
            
            # Download subtitle content
            subtitle_response = await client.get(download_url)
            
            if subtitle_response.status_code == 200:
                content = subtitle_response.text
                
                # Convert SRT to VTT if needed
                if file_info.get("name", "").lower().endswith('.srt'):
                    content = convert_srt_to_vtt(content)
                
                return Response(
                    content=content,
                    media_type="text/vtt",
                    headers={"Cache-Control": "public, max-age=3600"}
                )
            
            raise HTTPException(status_code=404, detail="Subtitle content not available")
            
    except Exception as e:
        logger.error(f"Get subtitle content error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get subtitle content")

def convert_srt_to_vtt(srt_content):
    """Convert SRT subtitle format to VTT format"""
    lines = srt_content.strip().split('\n')
    vtt_lines = ['WEBVTT\n']
    
    for line in lines:
        line = line.strip()
        if '-->' in line:
            # Convert timestamp format from SRT to VTT
            line = line.replace(',', '.')
        vtt_lines.append(line)
    
    return '\n'.join(vtt_lines)

# Health check
@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "service": "OneDrive File Explorer API"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)