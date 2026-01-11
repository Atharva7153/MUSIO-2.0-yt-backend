# Dual MongoDB Architecture Setup

## Overview
Your YouTube download backend now supports a **dual MongoDB architecture** that matches your Next.js frontend:

- **OLD Database**: For reading existing/legacy data (read-only operations)
- **NEW Database**: For writing all new data (songs, playlists)

## Changes Made

### 1. Environment Variables (`.env`)
Added two separate MongoDB connection URIs:
```env
MONGO_URI_OLD = mongodb+srv://AtharvaS7153:ddskdhf123@atharvadb.olmumix.mongodb.net/
MONGO_URI_NEW = mongodb+srv://atharvasharma1001_db_user:ddskdhf123@test.l8f73ag.mongodb.net/
```

### 2. Database Connections (`index.js`)
Created two separate Mongoose connections:
```javascript
// OLD DB: For reading existing/legacy data
const mongoOld = mongoose.createConnection(process.env.MONGO_URI_OLD);

// NEW DB: For writing all new data
const mongoNew = mongoose.createConnection(process.env.MONGO_URI_NEW);
```

### 3. Model Structure
Updated both models to export schemas instead of compiled models:

**models/Song.js**:
```javascript
const SongSchema = new mongoose.Schema({...});
export { SongSchema };
export default SongSchema;
```

**models/Playlist.js**:
```javascript
const PlaylistSchema = new mongoose.Schema({...});
export { PlaylistSchema };
export default PlaylistSchema;
```

### 4. Model Instances (`index.js`)
Created separate model instances for each database:
```javascript
// Models for OLD database (read-only)
const SongOld = mongoOld.model("Song", SongSchema);
const PlaylistOld = mongoOld.model("Playlist", PlaylistSchema);

// Models for NEW database (write operations)
const SongNew = mongoNew.model("Song", SongSchema);
const PlaylistNew = mongoNew.model("Playlist", PlaylistSchema);
```

### 5. Route Updates

#### GET `/playlists` - Read from OLD DB
```javascript
app.get('/playlists', async (req, res) => {
  const lists = await PlaylistOld.find().populate('songs').lean();
  res.json(lists);
});
```

#### POST `/yt-upload` - Write to NEW DB
```javascript
app.post("/yt-upload", async (req, res) => {
  // Save song to NEW database
  const song = new SongNew({...});
  await song.save();
  
  // Save playlist to NEW database
  const playlist = new PlaylistNew({...});
  await playlist.save();
});
```

## How It Works

1. **Reading Data**: All GET requests use models from `mongoOld` connection to read existing/legacy data
2. **Writing Data**: All POST requests use models from `mongoNew` connection to write new songs and playlists
3. **Data Flow**: 
   - Legacy data remains in OLD database
   - New downloads/uploads go to NEW database
   - Frontend can query both databases through your API

## Testing

Server is running on `http://localhost:4000` with both database connections active:
- ✅ MongoDB OLD connected (read-only)
- ✅ MongoDB NEW connected (write operations)

## API Endpoints

- `GET /` - Welcome page
- `GET /health` - Health check
- `GET /playlists` - List all playlists (from OLD DB)
- `POST /yt-upload` - Download YouTube video and save to NEW DB
- `GET /cookie-expiry` - Check YouTube cookie expiry

## Notes

- Both databases use the same schema structure
- All new data (songs, playlists) will be written to the NEW database
- Legacy data remains accessible from the OLD database
- This architecture ensures data separation while maintaining backward compatibility
