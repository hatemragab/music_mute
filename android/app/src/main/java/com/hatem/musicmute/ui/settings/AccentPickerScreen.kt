package com.hatem.musicmute.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.VocalTheme
import com.hatem.musicmute.ui.design.*
import java.util.Locale

@Composable
fun AccentPickerScreen(initialAccent: Int, onBack: () -> Unit, onApply: (Int) -> Unit) {
    var hex by rememberSaveable(initialAccent) { mutableStateOf(String.format(Locale.ROOT, "#%06X", initialAccent and 0xFFFFFF)) }
    val parsed = AccentPalette.parse(hex)
    val preview = parsed ?: initialAccent
    val presets = listOf(
        AccentPalette.DEFAULT to R.string.creative_settings_orange,
        0xFF48C847.toInt() to R.string.creative_settings_green,
        0xFF2C95F7.toInt() to R.string.creative_settings_blue,
        0xFFA842EA.toInt() to R.string.creative_settings_purple,
        0xFFF45191.toInt() to R.string.creative_settings_pink,
        0xFFF5C941.toInt() to R.string.creative_settings_gold,
    )
    CreativePage {
        TextButton(onClick = onBack) { Text(stringResource(R.string.back)) }
        CreativeHeader(stringResource(R.string.creative_settings_accent), stringResource(R.string.creative_settings_accent_description))
        CreativeCard {
            Text(stringResource(R.string.creative_settings_presets), style = MaterialTheme.typography.titleMedium)
            Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                presets.chunked(3).forEach { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        row.forEach { (value, label) ->
                            Column(
                                Modifier.weight(1f).selectable(selected = parsed == value, role = Role.RadioButton,
                                    onClick = { hex = String.format(Locale.ROOT, "#%06X", value and 0xFFFFFF) }),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Box(Modifier.size(64.dp)
                                    .border(if (parsed == value) 2.dp else 0.dp, MaterialTheme.colorScheme.onSurface, CircleShape)
                                    .padding(5.dp).background(Color(value), CircleShape), contentAlignment = Alignment.Center) {
                                    if (parsed == value) Icon(Icons.Outlined.Check, null, tint = Color(AccentPalette.foreground(value)))
                                }
                                Text(stringResource(label), style = MaterialTheme.typography.labelLarge)
                            }
                        }
                    }
                }
            }
        }
        CreativeCard {
            Text(stringResource(R.string.creative_settings_custom), style = MaterialTheme.typography.titleMedium)
            CreativeTextField(hex, { hex = it }, stringResource(R.string.creative_settings_hex),
                error = if (parsed == null) stringResource(R.string.creative_settings_invalid_hex) else null)
        }
        VocalTheme(accentArgb = preview) {
            CreativeCard {
                Text(stringResource(R.string.creative_settings_preview), style = MaterialTheme.typography.titleMedium)
                CreativeWave(Modifier.fillMaxWidth())
                CreativePrimaryButton({}, Modifier.fillMaxWidth()) { Text(stringResource(R.string.creative_settings_preview_action)) }
            }
        }
        CreativePrimaryButton(onClick = { parsed?.let(onApply) }, enabled = parsed != null, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.creative_settings_apply))
        }
        TextButton(onClick = { hex = "#FF814A" }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text(stringResource(R.string.creative_settings_reset))
        }
    }
}
