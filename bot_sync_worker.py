import discord
from discord.ext import commands
from discord import app_commands
import requests
import asyncio
import os

# ---------------------------------------------------------
# KONFIGURACJA
# ---------------------------------------------------------
TOKEN = 'trututu_token_z_drutu'
SERVER_A_ID = 696767676767  # ID Serwera A

# Adres i klucz do Cloudflare Workera
WORKER_URL = "https://your.worker.url.workers.dev/api/update"
WORKER_SECRET = "ja_j4b4_chuj_serniktopedal"

# Lista ID użytkowników uprawnionych do ręcznego wywołania syncu
ALLOWED_USERS = [67676767676767]

# ---------------------------------------------------------
# FUNKCJE BUDOWANIA I WYSYŁANIA DANYCH
# ---------------------------------------------------------
async def build_and_push_data(bot: commands.Bot):
    """Skanuje Serwer A i wysyła pełną strukturę JSON do Cloudflare Workera."""
    guild = bot.get_guild(SERVER_A_ID)
    if not guild:
        print("[BŁĄD] Nie znaleziono Serwera A!")
        return False

    structure = {}

    for category in guild.categories:
        cat_name = category.name
        cat_dict = {}

        for channel in category.text_channels:
            chan_name = channel.name

            # -----------------------------------------------------
            # 1. POBIERANIE PLIKÓW BEZPOŚREDNIO Z KANAŁU (POZA WĄTKAMI)
            # -----------------------------------------------------
            direct_files = []
            try:
                async for msg in channel.history(limit=None, oldest_first=True):
                    if msg.attachments and not msg.author.bot:
                        for att in msg.attachments:
                            direct_files.append({
                                "name": att.filename,
                                "url": att.url,
                                "size": f"{round(att.size / (1024 * 1024), 2)} MB"
                            })
            except Exception as e:
                print(f"[OSTRZEŻENIE] Błąd podczas pobierania historii kanału {chan_name}: {e}")

            if direct_files:
                direct_files.sort(key=lambda x: x["name"].lower())

            # -----------------------------------------------------
            # 2. POBIERANIE PLIKÓW Z WĄTKÓW (AKTYWNYCH I ZARCHIWIZOWANYCH)
            # -----------------------------------------------------
            threads = list(channel.threads)
            try:
                async for archived_thread in channel.archived_threads(limit=None):
                    threads.append(archived_thread)
            except Exception as e:
                print(f"[OSTRZEŻENIE] Błąd podczas pobierania archiwum wątków w {chan_name}: {e}")

            threads_dict = {}
            for thread in threads:
                thread_name = thread.name
                file_list = []

                try:
                    async for msg in thread.history(limit=None, oldest_first=True):
                        if msg.attachments and not msg.author.bot:
                            for att in msg.attachments:
                                file_list.append({
                                    "name": att.filename,
                                    "url": att.url,
                                    "size": f"{round(att.size / (1024 * 1024), 2)} MB"
                                })
                except Exception as e:
                    print(f"[OSTRZEŻENIE] Błąd podczas pobierania historii wątku {thread_name}: {e}")

                if file_list:
                    file_list.sort(key=lambda x: x["name"].lower())
                    threads_dict[thread_name] = file_list

            # -----------------------------------------------------
            # 3. STRUKTURALIZACJA BEZ DUBLOWANIA
            # -----------------------------------------------------
            # Jeśli brak wątków, a są tylko pliki na kanale -> przypisz bezpośrednio tablicę
            if direct_files and not threads_dict:
                cat_dict[chan_name] = direct_files
            # Jeśli są wątki (z plikami lub bez plików na kanale głównym)
            elif threads_dict:
                if direct_files:
                    threads_dict["Inne pliki"] = direct_files
                cat_dict[chan_name] = threads_dict

        if cat_dict:
            structure[cat_name] = cat_dict

    # Wysyłanie wygenerowanego JSON-a do Workera
    headers = {
        "Authorization": f"Bearer {WORKER_SECRET}",
        "Content-Type": "application/json"
    }

    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, 
            lambda: requests.post(WORKER_URL, json=structure, headers=headers, timeout=10)
        )
        if response.status_code == 200:
            print("[SUKCES] Zaktualizowano strukturę w Cloudflare Workerze!")
            return True
        else:
            print(f"[BŁĄD HTTP] Worker zwrócił kod {response.status_code}: {response.text}")
            return False
    except Exception as e:
        print(f"[BŁĄD SIECI] Nie udało się połączyć z Cloudflare Workerem: {e}")
        return False

# ---------------------------------------------------------
# INICJALIZACJA BOTA DISCORDA
# ---------------------------------------------------------
class SiteSyncBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.messages = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        await self.tree.sync()
        print("Zsynchronizowano komendy Slash (/)")

bot = SiteSyncBot()

@bot.event
async def on_ready():
    print(f'Zalogowano jako {bot.user} (Site Sync Bot)')
    print("Inicjalizacja pierwszej synchronizacji ze stroną...")
    await build_and_push_data(bot)

# ---------------------------------------------------------
# KOMENDA SLASH DO RĘCZNEJ SYNCHRONIZACJI
# ---------------------------------------------------------
@bot.tree.command(name="update_site", description="Ręcznie aktualizuje strukturę plików na stronie WWW")
async def update_site(interaction: discord.Interaction):
    if interaction.user.id not in ALLOWED_USERS:
        return await interaction.response.send_message("Nie masz uprawnień do tej komendy.", ephemeral=True)

    await interaction.response.defer(ephemeral=True)
    success = await build_and_push_data(bot)

    if success:
        await interaction.followup.send("Strona została pomyślnie zaktualizowana!")
    else:
        await interaction.followup.send("Wystąpił błąd podczas aktualizacji strony. Sprawdź konsolę bota.")

# ---------------------------------------------------------
# ZDARZENIA AUTOMATYCZNE (DODANIE / USUNIĘCIE PLIKU)
# ---------------------------------------------------------
@bot.event
async def on_message(message):
    # Reaguj tylko na wiadomości z plikami na Serwerze A
    if message.guild and message.guild.id == SERVER_A_ID:
        if message.attachments and not message.author.bot:
            print(f"[ZDARZENIE] Wykryto nowy plik w: {message.channel.name}. Aktualizacja strony...")
            await asyncio.sleep(2) # Krótkie opóźnienie na przetworzenie załącznika przez Discorda
            await build_and_push_data(bot)

@bot.event
async def on_message_delete(message):
    if message.guild and message.guild.id == SERVER_A_ID:
        print(f"[ZDARZENIE] Wykryto usunięcie wiadomości na Serwerze A. Aktualizacja strony...")
        await build_and_push_data(bot)

# ---------------------------------------------------------
# URUCHOMIENIE
# ---------------------------------------------------------
bot.run(TOKEN)