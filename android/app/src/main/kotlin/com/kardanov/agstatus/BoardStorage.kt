package com.kardanov.agstatus

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * The workspace token is a secret, so the Board lives in an
 * EncryptedSharedPreferences file — the Android counterpart of the iOS
 * Keychain (BoardKeychain.swift).
 */
object BoardStorage {

    private const val ENCRYPTED_FILE = "agstatus_board"
    private const val PLAIN_FILE = "agstatus_board_plain"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_TOKEN = "token"

    @Volatile
    private var cached: SharedPreferences? = null

    /**
     * The saved board, re-run through Board.restore on the way out rather
     * than trusted because this app wrote it. Earlier builds saved the raw
     * authority of whatever URL was scanned, so a board adopted from a
     * crafted QR still carries `https://x;$(cmd);@agstatus.online` here, and
     * fixing the parser does nothing for a value that is already on disk.
     *
     * A repaired board is written back, so this happens once rather than on
     * every launch. One restore cannot rescue is forgotten on this device
     * only, exactly as Settings' "Disconnect this device" forgets one: the
     * board on the server is untouched.
     */
    fun load(context: Context): Board? {
        val prefs = prefs(context)
        val baseUrl = prefs.getString(KEY_BASE_URL, null)?.takeIf { it.isNotBlank() } ?: return null
        val token = prefs.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
        val board = Board.restore(baseUrl, token)
        when {
            board == null -> clear(context)
            board.baseUrl != baseUrl -> save(context, board)
        }
        return board
    }

    fun save(context: Context, board: Board) {
        val editor = prefs(context).edit()
        editor.putString(KEY_BASE_URL, board.baseUrl)
        if (board.token == null) editor.remove(KEY_TOKEN) else editor.putString(KEY_TOKEN, board.token)
        editor.apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().remove(KEY_BASE_URL).remove(KEY_TOKEN).apply()
    }

    private fun prefs(context: Context): SharedPreferences {
        cached?.let { return it }
        return synchronized(this) {
            cached ?: open(context.applicationContext).also { cached = it }
        }
    }

    /**
     * Opening the encrypted store throws on some devices when the keystore
     * keyset is corrupted or the backing file was restored from another
     * install. A corrupted keyset can only be discarded, so drop the file and
     * retry once; if even that fails, degrade to plain preferences rather than
     * crashing the app at launch.
     */
    private fun open(context: Context): SharedPreferences =
        try {
            encrypted(context)
        } catch (_: Exception) {
            context.deleteSharedPreferences(ENCRYPTED_FILE)
            try {
                encrypted(context)
            } catch (_: Exception) {
                context.getSharedPreferences(PLAIN_FILE, Context.MODE_PRIVATE)
            }
        }

    private fun encrypted(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            ENCRYPTED_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }
}
