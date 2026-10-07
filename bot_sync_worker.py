import discord
from discord.ext import commands
from discord import app_commands
import requests
import asyncio
import os
import datetime
import re
import io

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

# Zmienne globalne przetrzymujące stan z ostatniej synchronizacji
GLOBAL_TOTAL_BYTES = 0
GLOBAL_STRUCTURE = {}

# ---------------------------------------------------------
# FUNKCJE POMOCNICZE
# ---------------------------------------------------------
def log(tag, message):
    """Odpowiada za ustandaryzowane formatowanie printów z datą."""
    now = datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    print(f"[{now}] [{tag}] {message}")

def check_episodes(file_list, context_name):
    """Sprawdza ciągłość odcinków i zwraca listę logów (ostrzeżeń)."""
    messages = []
    episodes = set()
    
    for f in file_list:
        # Szuka wzorca np. S01E05, S1E5, E12, E012
        match = re.search(r'(?i)(?:S\d{1,2})?E(\d{1,4})', f["name"])
        if match:
            episodes.add(int(match.group(1)))
    
    if episodes:
        max_ep = max(episodes)
        # Tworzymy listę brakujących i sortujemy ją
        missing = sorted([ep for ep in range(1, max_ep + 1) if ep not in episodes])
        
        if missing:
            # Formatuje liczby dodając zera na początku, np. E03 zamiast 3
            missing_str = ", ".join([f"E{ep:02d}" for ep in missing])
            max_str = f"E{max_ep:02d}"
            messages.append(f"[OSTRZEŻENIE] W '{context_name}' brakuje odcinków: {missing_str} (najwyższy wrzucony to {max_str})")
            
    return messages

def check_multiparts(file_list, context_name):
    """Sprawdza kompletność plików .partXX i zwraca listę logów (ostrzeżenia i sukcesy)."""
    messages = []
    files_dict = {}
    
    for f in file_list:
        match = re.search(r'(?i)^(.*?)\.part(\d+)(.*?)$', f["name"])
        if match:
            base_name = match.group(1) + match.group(3)
            part_num = int(match.group(2))
            size = f["bytes"]

            if base_name not in files_dict:
                files_dict[base_name] = {"parts": set(), "last_part": None}
            
            files_dict[base_name]["parts"].add(part_num)
            
            # Wg PowerShell part mniejszy niż 996147200 (950MB) oznacza koniec pliku
            if size < 996147200:
                files_dict[base_name]["last_part"] = part_num
    
    for base_name, data in files_dict.items():
        parts = data["parts"]
        last_part = data["last_part"]

        if not parts:
            continue
        
        target_max = last_part if last_part is not None else max(parts)
        missing = [p for p in range(1, target_max + 1) if p not in parts]

        if missing:
            messages.append(f"[OSTRZEŻENIE] W '{context_name}' brakuje części dla '{base_name}': part{missing}")
        elif last_part is not None:
            messages.append(f"[SUKCES] {base_name} w '{context_name}' jest kompletne.")
            
    return messages

def check_duplicates(file_list, context_name):
    """Sprawdza czy na liście nie ma zduplikowanych plików (po nazwie)."""
    messages = []
    name_counts = {}
    
    for f in file_list:
        name = f["name"]
        name_counts[name] = name_counts.get(name, 0) + 1
        
    for name, count in name_counts.items():
        if count > 1:
            messages.append(f"[OSTRZEŻENIE] W '{context_name}' znaleziono duplikat pliku ({count}x): '{name}'")
            
    return messages

# ---------------------------------------------------------
# FUNKCJE BUDOWANIA I WYSYŁANIA DANYCH
# ---------------------------------------------------------
async def build_and_push_data(bot: commands.Bot):
    """Skanuje Serwer A i wysyła pełną strukturę JSON do Cloudflare Workera."""
    global GLOBAL_TOTAL_BYTES, GLOBAL_STRUCTURE
    
    guild = bot.get_guild(SERVER_A_ID)
    if not guild:
        log("BŁĄD", "Nie znaleziono Serwera A!")
        return False

    structure = {}
    current_total_bytes = 0

    for category in guild.categories:
        cat_name = category.name
        cat_dict = {}

        for channel in category.text_channels:
            chan_name = channel.name
            direct_files = []

            try:
                async for msg in channel.history(limit=None, oldest_first=True):
                    if msg.attachments and not msg.author.bot:
                        for att in msg.attachments:
                            current_total_bytes += att.size
                            direct_files.append({
                                "name": att.filename,
                                "url": att.url,
                                "size": f"{round(att.size / (1024 * 1024), 2)} MB",
                                "bytes": att.size
                            })
            except Exception as e:
                log("OSTRZEŻENIE", f"Błąd podczas pobierania historii kanału {chan_name}: {e}")

            if direct_files:
                direct_files.sort(key=lambda x: x["name"].lower())

            threads = list(channel.threads)
            try:
                async for archived_thread in channel.archived_threads(limit=None):
                    threads.append(archived_thread)
            except Exception as e:
                log("OSTRZEŻENIE", f"Błąd podczas pobierania archiwum wątków w {chan_name}: {e}")

            threads_dict = {}
            for thread in threads:
                thread_name = thread.name
                file_list = []

                try:
                    async for msg in thread.history(limit=None, oldest_first=True):
                        if msg.attachments and not msg.author.bot:
                            for att in msg.attachments:
                                current_total_bytes += att.size
                                file_list.append({
                                    "name": att.filename,
                                    "url": att.url,
                                    "size": f"{round(att.size / (1024 * 1024), 2)} MB",
                                    "bytes": att.size
                                })
                except Exception as e:
                    log("OSTRZEŻENIE", f"Błąd podczas pobierania historii wątku {thread_name}: {e}")

                if file_list:
                    file_list.sort(key=lambda x: x["name"].lower())
                    threads_dict[thread_name] = file_list

            if direct_files and not threads_dict:
                cat_dict[chan_name] = direct_files
            elif threads_dict:
                if direct_files:
                    threads_dict["Inne pliki"] = direct_files
                cat_dict[chan_name] = threads_dict

        if cat_dict:
            structure[cat_name] = cat_dict

    # Zapisz do pamięci bota po przeskanowaniu
    GLOBAL_TOTAL_BYTES = current_total_bytes
    GLOBAL_STRUCTURE = structure

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
            log("SUKCES", "Zaktualizowano strukturę w Cloudflare Workerze!")
            return True
        else:
            log("BŁĄD HTTP", f"Worker zwrócił kod {response.status_code}: {response.text}")
            return False
    except Exception as e:
        log("BŁĄD SIECI", f"Nie udało się połączyć z Cloudflare Workerem: {e}")
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
        log("INFO", "Zsynchronizowano komendy Slash (/)")

bot = SiteSyncBot()

@bot.event
async def on_ready():
    log("INFO", f'Zalogowano jako {bot.user} (Site Sync Bot)')
    log("INFO", "Inicjalizacja pierwszej synchronizacji ze stroną...")
    await build_and_push_data(bot)

# ---------------------------------------------------------
# KOMENDY SLASH
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

@bot.tree.command(name="staty", description="Pokazuje łączną ilość udostępnionych danych na serwerze")
async def staty(interaction: discord.Interaction):
    mb = GLOBAL_TOTAL_BYTES / (1024 ** 2)
    gb = GLOBAL_TOTAL_BYTES / (1024 ** 3)
    tb = GLOBAL_TOTAL_BYTES / (1024 ** 4)

    embed = discord.Embed(title="📊 Statystyki plików na serwerze", color=discord.Color.blue())
    embed.add_field(name="TB", value=f"{tb:,.4f}", inline=True)
    embed.add_field(name="GB", value=f"{gb:,.2f}", inline=True)
    embed.add_field(name="MB", value=f"{mb:,.2f}", inline=True)
    
    await interaction.response.send_message(embed=embed)

@bot.tree.command(name="check", description="Sprawdza kompletność partów, odcinków i duplikaty w pamięci bota")
@app_commands.describe(only_warns="Pokaż tylko ostrzeżenia (ukrywa sukcesy). Domyślnie: True")
async def check_files(interaction: discord.Interaction, only_warns: bool = True):
    if interaction.user.id not in ALLOWED_USERS:
        return await interaction.response.send_message("Nie masz uprawnień do tej komendy.", ephemeral=True)

    await interaction.response.defer(ephemeral=True)

    if not GLOBAL_STRUCTURE:
        return await interaction.followup.send("Brak danych w pamięci. Zaktualizuj stronę używając `/update_site`.")

    report_lines = []

    # Iterowanie przez strukturę zapisaną w pamięci (zmienna globalna)
    for cat_name, cat_data in GLOBAL_STRUCTURE.items():
        for chan_name, chan_data in cat_data.items():
            if isinstance(chan_data, list):
                # Zwykła tablica plików bez wątków
                report_lines.extend(check_episodes(chan_data, chan_name))
                report_lines.extend(check_multiparts(chan_data, chan_name))
                report_lines.extend(check_duplicates(chan_data, chan_name))
            elif isinstance(chan_data, dict):
                # Tablice plików podzielone na wątki
                for thread_name, file_list in chan_data.items():
                    context = f"{chan_name} -> {thread_name}"
                    report_lines.extend(check_episodes(file_list, context))
                    report_lines.extend(check_multiparts(file_list, context))
                    report_lines.extend(check_duplicates(file_list, context))

    # Odfiltrowanie wiadomości oznaczonych jako [SUKCES], jeśli only_warns jest True
    if only_warns:
        report_lines = [line for line in report_lines if "[OSTRZEŻENIE]" in line]

    if not report_lines:
        if only_warns:
            return await interaction.followup.send("✅ Brak ostrzeżeń! Wszystkie sprawdzane pliki wydają się kompletne.")
        else:
            return await interaction.followup.send("✅ Wszystkie wrzucone pliki, odcinki i party wyglądają na kompletne! Brak duplikatów.")

    full_report = "\n".join(report_lines)

    # Sprawdzenie czy raport zmieści się w jednej wiadomości tekstowej na Discord
    if len(full_report) > 1900:
        file_obj = io.BytesIO(full_report.encode('utf-8'))
        discord_file = discord.File(file_obj, filename="raport_braki.txt")
        await interaction.followup.send("⚠️ Znalazłem raporty, ale lista była za długa. Przesyłam w załączniku:", file=discord_file)
    else:
        await interaction.followup.send(f"⚠️ Znalezione raporty:\n```\n{full_report}\n```")

# ---------------------------------------------------------
# ZDARZENIA AUTOMATYCZNE (DODANIE / USUNIĘCIE PLIKU)
# ---------------------------------------------------------
@bot.event
async def on_message(message):
    if message.guild and message.guild.id == SERVER_A_ID:
        if message.attachments and not message.author.bot:
            log("ZDARZENIE", f"Wykryto nowy plik w: {message.channel.name}. Aktualizacja strony...")
            await asyncio.sleep(2)
            await build_and_push_data(bot)

@bot.event
async def on_message_delete(message):
    if message.guild and message.guild.id == SERVER_A_ID:
        log("ZDARZENIE", "Wykryto usunięcie wiadomości na Serwerze A. Aktualizacja strony...")
        await build_and_push_data(bot)

# ---------------------------------------------------------
# URUCHOMIENIE
# ---------------------------------------------------------
bot.run(TOKEN)
