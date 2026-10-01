
# Discord CDN index
As of recent update Nitro users can attach files up to 1GB in size. This PoC exploits exactly that.
This PoC consits of two parts: a free cloudflare worker that hosts the site and discord bot that fatches all data and sends it to the worker.
![preview](https://github.com/TheRadziu/Discord-CDN-index/blob/main/screenshot_worker_site.png?raw=true)
![backend example](https://github.com/TheRadziu/Discord-CDN-index/blob/main/screenshot_backend.png?raw=true)

# How it works?
Upload file to discord and it shows up in the index, as simple as that. 
The chirarchy is as follows:
Category -> First folder (category)
Channel -> subfolder
Thread -> subfolder
Message with attachment -> File

So uploading a file example.mov to a thread in channel named Test_1 that is in Big_Test category will end up with path of `/Big_Test/Test_1/example.mov`
If you dont get it compare both above screenshots. It's that easy.

Discord bot updates the index on each run, then every time new message is made or deleted, making manual `/sync` command obsolete.

# How-to:
1. Create new Cloudflare worker with KV namespace `MEDIA_KV`
2. Copy paste the content of a `worker.js`. Change API_SECRET to something and make note of that. `ACCESS_PASSWORD` is access to the site password. 
3. Create new discord server and new discord bot with access to messages and history.
4. Edit bot_sync_worker.py with: bot's token in `TOKEN`, server's ID in `SERVER_A_ID`, `WORKER_URL` with your url. Make sure it ends with `/api/update`, `WORKER_SECRET` has to be the same as `API_SECRET` above, lastly `ALLOWED_USERS` are people with access to `/sync` command but its obsolete, look above for explanation.
5. Run the bot and keep it running (or at least every now and then to update the index)

# Credits:
Completly vibecoded with free gemini, uses open source [movi-player](https://github.com/mrujjwalg/movi-player) to allow playback of mkv files and selectable multiple audio and subtitle tracks.
