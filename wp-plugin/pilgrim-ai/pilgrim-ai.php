<?php
/**
 * Plugin Name: Pilgrim AI Widget
 * Description: Loads the Pilgrim AI lazy chat launcher on the front end. Chat bundle loads on first click.
 * Version: 0.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 * Text Domain: pilgrim-ai
 */

defined( 'ABSPATH' ) || exit;

const PILGRIM_AI_OPTION = 'pilgrim_ai_settings';

/** Returns a normalized http(s) URL or '' (fail closed). */
function pilgrim_ai_clean_url( $raw ): string {
	if ( ! is_string( $raw ) ) {
		return '';
	}
	$raw = trim( $raw );
	if ( '' === $raw || preg_match( '/[\s<>"\'\\\\]/', $raw ) || ! filter_var( $raw, FILTER_VALIDATE_URL ) ) {
		return '';
	}
	$parts = wp_parse_url( $raw );
	if ( empty( $parts['host'] ) || ! in_array( $parts['scheme'] ?? '', array( 'http', 'https' ), true ) ) {
		return '';
	}
	return $raw;
}

/** Same rule as the loader: [A-Za-z0-9_-]+ ; \z avoids the trailing-newline `$` quirk. */
function pilgrim_ai_clean_tenant( $raw ): string {
	$raw = is_string( $raw ) ? trim( $raw ) : '';
	return preg_match( '/^[A-Za-z0-9_-]+\z/', $raw ) ? $raw : '';
}

function pilgrim_ai_sanitize( $input ): array {
	$input = is_array( $input ) ? $input : array();
	$out   = array(
		'loader_url' => pilgrim_ai_clean_url( $input['loader_url'] ?? '' ),
		'tenant'     => pilgrim_ai_clean_tenant( $input['tenant'] ?? '' ),
		'api_url'    => pilgrim_ai_clean_url( $input['api_url'] ?? '' ),
		'bundle_url' => pilgrim_ai_clean_url( $input['bundle_url'] ?? '' ),
		'local_assets' => '1' === ( $input['local_assets'] ?? '' ) ? '1' : '0',
	);
	// With local assets the URLs come from the plugin, so only tenant is required.
	foreach ( '1' === $out['local_assets'] ? array( 'tenant' ) : array( 'loader_url', 'tenant', 'bundle_url' ) as $required ) {
		if ( '' === $out[ $required ] ) {
			add_settings_error( PILGRIM_AI_OPTION, 'pilgrim_ai_' . $required, sprintf( 'Pilgrim AI: "%s" is missing or invalid; the widget is disabled.', $required ) );
		}
	}
	if ( '' === $out['api_url'] && '' !== trim( (string) ( $input['api_url'] ?? '' ) ) ) {
		add_settings_error( PILGRIM_AI_OPTION, 'pilgrim_ai_api_url', 'Pilgrim AI: "api_url" is invalid and was cleared.' );
	}
	return $out;
}

/** Returns the script tag HTML, or '' when config is incomplete/unsafe. Pure: no globals. */
function pilgrim_ai_script_tag( $settings ): string {
	$s      = is_array( $settings ) ? $settings : array();
	$loader = pilgrim_ai_clean_url( $s['loader_url'] ?? '' );
	$tenant = pilgrim_ai_clean_tenant( $s['tenant'] ?? '' );
	$bundle = pilgrim_ai_clean_url( $s['bundle_url'] ?? '' );
	$api    = pilgrim_ai_clean_url( $s['api_url'] ?? '' );
	if ( '' === $loader || '' === $tenant || '' === $bundle ) {
		return '';
	}
	$attrs = sprintf( ' src="%s" defer data-tenant="%s" data-bundle-url="%s"', esc_url( $loader ), esc_attr( $tenant ), esc_url( $bundle ) );
	if ( '' !== $api ) {
		$attrs .= sprintf( ' data-api-url="%s"', esc_url( $api ) );
	}
	return '<script' . $attrs . '></script>' . "\n";
}

/** Opt-in: swap loader/bundle URLs for the plugin's bundled assets. Missing files => '' URLs => nothing emitted. */
function pilgrim_ai_local_settings( $settings, string $dir, string $url ): array {
	$s = is_array( $settings ) ? $settings : array();
	if ( '1' !== ( $s['local_assets'] ?? '' ) ) {
		return $s;
	}
	$ok = is_readable( $dir . 'loader.js' ) && is_readable( $dir . 'chat.js' );
	$s['loader_url'] = $ok ? $url . 'loader.js' : '';
	$s['bundle_url'] = $ok ? $url . 'chat.js' : '';
	return $s;
}

function pilgrim_ai_print_script(): void {
	static $printed = false; // duplicate prevention
	if ( $printed || is_admin() || is_feed() ) {
		return;
	}
	$tag = pilgrim_ai_script_tag(
		pilgrim_ai_local_settings( get_option( PILGRIM_AI_OPTION, array() ), plugin_dir_path( __FILE__ ) . 'assets/', plugins_url( 'assets/', __FILE__ ) )
	);
	if ( '' === $tag ) {
		return;
	}
	$printed = true;
	echo $tag; // phpcs:ignore WordPress.Security.EscapeOutput -- built from esc_url/esc_attr above.
}
add_action( 'wp_footer', 'pilgrim_ai_print_script', 20 );

function pilgrim_ai_register_settings(): void {
	// options.php verifies the settings_fields() nonce and the manage_options capability.
	register_setting(
		'pilgrim_ai',
		PILGRIM_AI_OPTION,
		array(
			'type'              => 'array',
			'sanitize_callback' => 'pilgrim_ai_sanitize',
			'default'           => array(),
			'show_in_rest'      => false,
		)
	);
}
add_action( 'admin_init', 'pilgrim_ai_register_settings' );

function pilgrim_ai_menu(): void {
	add_options_page( 'Pilgrim AI', 'Pilgrim AI', 'manage_options', 'pilgrim-ai', 'pilgrim_ai_render_page' );
}
add_action( 'admin_menu', 'pilgrim_ai_menu' );

function pilgrim_ai_render_page(): void {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html( 'You do not have permission to access this page.' ), 403 );
	}
	$o      = get_option( PILGRIM_AI_OPTION, array() );
	$o      = is_array( $o ) ? $o : array();
	$fields = array(
		'loader_url' => 'Loader URL (required)',
		'tenant'     => 'Tenant (required)',
		'bundle_url' => 'Chat bundle URL (required, loaded on first click)',
		'api_url'    => 'API URL (optional)',
	);
	echo '<div class="wrap"><h1>Pilgrim AI</h1>';
	settings_errors( PILGRIM_AI_OPTION );
	echo '<form method="post" action="options.php">';
	settings_fields( 'pilgrim_ai' );
	echo '<table class="form-table" role="presentation">';
	foreach ( $fields as $key => $label ) {
		printf(
			'<tr><th scope="row"><label for="pilgrim-ai-%1$s">%2$s</label></th><td><input type="text" class="regular-text" id="pilgrim-ai-%1$s" name="%3$s[%1$s]" value="%4$s" /></td></tr>',
			esc_attr( $key ),
			esc_html( $label ),
			esc_attr( PILGRIM_AI_OPTION ),
			esc_attr( (string) ( $o[ $key ] ?? '' ) )
		);
	}
	printf(
		'<tr><th scope="row"><label for="pilgrim-ai-local_assets">Use bundled local assets</label></th><td><input type="checkbox" id="pilgrim-ai-local_assets" name="%1$s[local_assets]" value="1" %2$s /> Ignore the Loader/Bundle URLs and serve loader.js and chat.js from this plugin.</td></tr>',
		esc_attr( PILGRIM_AI_OPTION ),
		checked( '1', (string) ( $o['local_assets'] ?? '' ), false )
	);
	echo '</table>';
	submit_button();
	echo '</form></div>';
}
